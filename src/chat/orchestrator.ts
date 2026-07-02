// Retrieval + chat-turn orchestration.
//
// The orchestrator retrieves, then composes the custom prompt + context +
// query; validates citations and persists a source-card snapshot; persists each
// turn per space; substitutes vars in the prompt only; treats a retrieval
// failure as distinct from empty (a failure never falls through to an
// ungrounded answer); budgets the context window; supports cancellation with no
// partial persistence on a mid-stream drop; and wraps retrieved content in
// delimited sources. topK defaults to 6, with a per-space similarityThreshold.
//
// The orchestrator is transport-agnostic: it yields typed events (sources,
// token, no-sources, done) as an async generator and throws typed errors
// (RetrievalError, no-Ollama-on-retrieval-failure). The SSE route in routes.ts
// adapts these to event-stream frames.

import { prisma } from "../db/client.js";
import { query, type CyborgHit, type SpaceRef } from "../cyborg/index-service.js";
import { streamChat, type ChatMessage } from "../ollama/client.js";
import { getSettings } from "../settings/service.js";
import {
  createConversation,
  appendMessage,
  deriveConversationTitle,
  setConversationTitle,
} from "../spaces/service.js";
import { composePrompt } from "./context.js";
import { validateCitations, toSourceCard, type SourceCard } from "./citations.js";

export const DEFAULT_TOP_K = 6;

// Context window we ask Ollama to use. Many models default to a huge window
// (e.g. 262144 for qwen3.6) which makes Ollama allocate a multi-GB KV cache and
// do heavy per-request prompt-cache work — ~30s of latency before the first
// token. Pinning a modest window keeps time-to-first-token low. It also bounds
// the prompt budgeting in composePrompt so the two stay consistent.
export const CHAT_NUM_CTX = 8192;

// Notice shown when no sources matched and the turn falls back to general chat
// (hybrid mode): the model answers from general knowledge, clearly labeled.
export const NO_SOURCES_NOTICE =
  "No matching sources in this space — answering from the model's general knowledge.";
export const RETRIEVAL_ERROR_MESSAGE =
  "Retrieval failed — the index is unreachable, so your question was not sent to the model. Try again in a moment.";

/**
 * Thrown when CyborgDB retrieval fails. Distinct from empty retrieval:
 * the orchestrator must NOT call Ollama and must surface this as an error, never
 * an ungrounded answer. The route maps it to a `retrieval-error` SSE event.
 */
export class RetrievalError extends Error {
  readonly cause?: unknown;
  constructor(cause?: unknown) {
    super(RETRIEVAL_ERROR_MESSAGE);
    this.name = "RetrievalError";
    this.cause = cause;
  }
}

// --- Event stream the route consumes --------------------------------------

export type TurnEvent =
  // The retrieved candidate cards for the sources rail, emitted at stream start
  // (before the LLM call) so the UI can populate the rail immediately. Empty
  // when the turn fell back to general chat (no matching sources).
  | { type: "sources"; cards: SourceCard[] }
  // Hybrid general-chat notice: no sources matched, so the answer that follows
  // is ungrounded (general knowledge) and the UI should label it as such.
  | { type: "notice"; message: string }
  // A streamed answer token.
  | { type: "token"; value: string }
  // Stream complete: validated citations + the persisted snapshot.
  // `grounded` is false for the general-chat fallback (cited/cards empty).
  // `timing` is the per-phase breakdown (ms) for the UI's timing bar.
  | {
      type: "done";
      conversationId: string;
      cited: number[];
      dropped: number[];
      cards: SourceCard[];
      grounded: boolean;
      timing: TurnTiming;
    };

/** Per-phase latency of a chat turn (ms), surfaced to the UI. */
export interface TurnTiming {
  retrievalMs: number; // CyborgDB query (embed + search)
  firstTokenMs: number; // query-done → first streamed token (Ollama prefill/queue)
  genMs: number; // first token → last token (generation)
  totalMs: number; // whole turn
}

export interface RunTurnInput {
  // Provide exactly one of conversationId (continue a thread) or spaceId (start
  // a new conversation in that space).
  conversationId?: string;
  spaceId?: string;
  userText: string;
  // Wired from the client disconnect by the route.
  signal?: AbortSignal;
  // Test seam: override the user's display name for `{{user.name}}`.
  userName?: string;
  // Owner for a conversation created via the spaceId path (chat privacy).
  userId?: string;
  topK?: number;
}

// Resolve the target conversation + its space, creating a conversation when only
// a spaceId was given. Returns the space row and chronological history.
async function resolveTarget(input: RunTurnInput): Promise<{
  conversationId: string;
  space: NonNullable<Awaited<ReturnType<typeof prisma.space.findUnique>>>;
  history: ChatMessage[];
}> {
  if (input.conversationId) {
    const conversation = await prisma.conversation.findUnique({
      where: { id: input.conversationId },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });
    if (!conversation) {
      throw new Error(`Conversation ${input.conversationId} not found.`);
    }
    const space = await prisma.space.findUnique({
      where: { id: conversation.spaceId },
    });
    if (!space) throw new Error(`Space ${conversation.spaceId} not found.`);
    const history: ChatMessage[] = conversation.messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.text }));
    return { conversationId: conversation.id, space, history };
  }

  if (input.spaceId) {
    const space = await prisma.space.findUnique({ where: { id: input.spaceId } });
    if (!space) throw new Error(`Space ${input.spaceId} not found.`);
    if (!input.userId) throw new Error("runTurn with spaceId requires userId (conversation owner).");
    const conversation = await createConversation(space.id, input.userId);
    return { conversationId: conversation.id, space, history: [] };
  }

  throw new Error("runTurn requires either conversationId or spaceId.");
}

// How many prior user turns to fold into a follow-up's retrieval query. A small
// window carries the topic without letting an old subject dominate the embedding.
const RETRIEVAL_HISTORY_TURNS = 2;

/**
 * Build the text used for retrieval: the last few user turns plus the current
 * message. On the first turn (no history) this is just the message. This keeps
 * follow-up questions grounded in the same material as the turn that set up the
 * topic, instead of retrieving on the bare follow-up alone.
 */
export function buildRetrievalQuery(history: ChatMessage[], userText: string): string {
  const recentUser = history
    .filter((m) => m.role === "user")
    .slice(-RETRIEVAL_HISTORY_TURNS)
    .map((m) => m.content);
  return [...recentUser, userText].join("\n");
}

function toSpaceRef(space: {
  id: string;
  slug: string;
  indexKey: string;
  embeddingModel: string | null;
}): SpaceRef {
  return {
    id: space.id,
    slug: space.slug,
    indexKey: space.indexKey,
    embeddingModel: space.embeddingModel,
  };
}

/**
 * Run a grounded chat turn, yielding events as they happen.
 *
 * Flow (chat-turn lifecycle):
 *  1. Resolve conversation + space + history.
 *  2. query CyborgDB (topK). On error → RetrievalError, NO Ollama call.
 *  3. Filter hits to similarity >= space.similarityThreshold. None → persist the
 *     user message + a no-sources assistant message and yield `no-sources`.
 *  4. Else emit `sources` (rail candidates), compose the prompt, stream Ollama,
 *     relay `token`s.
 *  5. After the stream: validate citations, persist the user message + assistant
 *     message with the snapshot, yield `done`.
 *
 * Cancellation: if the signal aborts mid-stream, the upstream fetch is
 * aborted, the error propagates, and NO partial assistant message is persisted.
 */
export async function* runTurn(
  input: RunTurnInput,
): AsyncGenerator<TurnEvent, void, unknown> {
  const t0 = Date.now();
  const { conversationId, space, history } = await resolveTarget(input);
  const topK = input.topK ?? DEFAULT_TOP_K;
  const spaceRef = toSpaceRef(space);

  // Auto-name the conversation from the first query (history empty = first turn).
  if (history.length === 0) {
    await setConversationTitle(
      conversationId,
      deriveConversationTitle(input.userText),
    );
  }

  // 2. Retrieve. A failure here must never fall through to Ollama.
  // Carry recent conversation context into the retrieval query so a follow-up
  // ("how long does it take?", "what about X?") still retrieves the right
  // sources instead of embedding the bare, context-free follow-up.
  let hits: CyborgHit[];
  const qStart = Date.now();
  try {
    hits = await query(spaceRef, buildRetrievalQuery(history, input.userText), topK);
  } catch (error) {
    throw new RetrievalError(error);
  }
  const retrievalMs = Date.now() - qStart;

  // 3. Filter to usable hits (similarity >= per-space threshold).
  const usable = hits.filter((h) => h.similarity >= space.similarityThreshold);

  if (usable.length === 0) {
    // Hybrid general-chat fallback: no matching sources, so answer from the
    // model's general knowledge, clearly labeled as ungrounded. (A CyborgDB
    // *failure* is still a hard RetrievalError above and never reaches here —
    // this branch is only the genuine empty-result case.)
    yield { type: "sources", cards: [] };
    yield { type: "notice", message: NO_SOURCES_NOTICE };

    const settings = await getSettings();
    const composed = composePrompt({
      customPrompt: space.customPrompt,
      vars: { spaceName: space.name, userName: input.userName },
      userText: input.userText,
      hits: [],
      history,
      grounded: false,
      numCtx: CHAT_NUM_CTX,
    });

    let answer = "";
    const genStart = Date.now();
    let firstAt = 0;
    for await (const token of streamChat({
      url: settings.ollamaUrl,
      model: settings.chatModel,
      messages: composed.messages,
      numCtx: CHAT_NUM_CTX,
      signal: input.signal,
    })) {
      if (!firstAt) firstAt = Date.now();
      answer += token;
      yield { type: "token", value: token };
    }
    const end = Date.now();

    await appendMessage(conversationId, { role: "user", text: input.userText });
    await appendMessage(conversationId, {
      role: "assistant",
      text: answer,
      sources: [],
    });
    yield {
      type: "done",
      conversationId,
      cited: [],
      dropped: [],
      cards: [],
      grounded: false,
      timing: {
        retrievalMs,
        firstTokenMs: (firstAt || end) - genStart,
        genMs: firstAt ? end - firstAt : 0,
        totalMs: end - t0,
      },
    };
    return;
  }

  // 4. Emit the rail candidates up front (known before the LLM call).
  const railCards = usable.map(toSourceCard);
  yield { type: "sources", cards: railCards };

  const settings = await getSettings();
  const composed = composePrompt({
    customPrompt: space.customPrompt,
    vars: { spaceName: space.name, userName: input.userName },
    userText: input.userText,
    hits: usable,
    history,
    numCtx: CHAT_NUM_CTX,
  });

  // Stream tokens, accumulating the full answer for post-stream citation
  // validation. A mid-stream abort throws out of the generator before any
  // persistence (no partial persisted).
  let answer = "";
  const genStart = Date.now();
  let firstAt = 0;
  for await (const token of streamChat({
    url: settings.ollamaUrl,
    model: settings.chatModel,
    messages: composed.messages,
    numCtx: CHAT_NUM_CTX,
    signal: input.signal,
  })) {
    if (!firstAt) firstAt = Date.now();
    answer += token;
    yield { type: "token", value: token };
  }
  const end = Date.now();

  // 5. Validate citations against the usable set and persist.
  const { citedNumbers, citedCards, droppedNumbers } = validateCitations(
    answer,
    usable,
  );

  await appendMessage(conversationId, { role: "user", text: input.userText });
  await appendMessage(conversationId, {
    role: "assistant",
    text: answer,
    sources: citedCards,
  });

  yield {
    type: "done",
    conversationId,
    cited: citedNumbers,
    dropped: droppedNumbers,
    cards: citedCards,
    grounded: true,
    timing: {
      retrievalMs,
      firstTokenMs: (firstAt || end) - genStart,
      genMs: firstAt ? end - firstAt : 0,
      totalMs: end - t0,
    },
  };
}
