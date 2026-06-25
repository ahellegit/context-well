// Retrieval + chat-turn orchestration (U10).
//
// Requirements: R16 (retrieve, then compose custom prompt + context + query),
// R17/R30 (validated citations + persisted source-card snapshot), R18 (no
// usable context → state the space has no sources, never answer ungrounded),
// R19 (persist the turn per space), R20 (var substitution in the prompt only),
// R25 (retrieval failure is distinct from empty and never falls through to an
// ungrounded answer), R26/KTD9 (context budgeting), R27 (cancellation; no
// partial persistence on a mid-stream drop), R29/KTD12 (delimited sources),
// KTD8 (topK default 6, per-space similarityThreshold).
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
} from "../spaces/service.js";
import { composePrompt } from "./context.js";
import { validateCitations, toSourceCard, type SourceCard } from "./citations.js";

export const DEFAULT_TOP_K = 6;

// Copy for the two grounded-refusal / failure states (R18 / R25).
export const NO_SOURCES_MESSAGE =
  "No relevant sources in this space — try syncing a connector or rephrasing your question.";
export const RETRIEVAL_ERROR_MESSAGE =
  "Retrieval failed — the index is unreachable, so your question was not sent to the model. Try again in a moment.";

/**
 * Thrown when CyborgDB retrieval fails (R25). Distinct from empty retrieval:
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
  // (before the LLM call) so the UI can populate the rail immediately.
  | { type: "sources"; cards: SourceCard[] }
  // A no-sources turn (R18): no usable hits, no LLM call. The conversation id
  // lets the client associate/refresh the thread.
  | { type: "no-sources"; conversationId: string; message: string }
  // A streamed answer token.
  | { type: "token"; value: string }
  // Stream complete: validated citations + the persisted snapshot (R17/R30).
  | {
      type: "done";
      conversationId: string;
      cited: number[];
      dropped: number[];
      cards: SourceCard[];
    };

export interface RunTurnInput {
  // Provide exactly one of conversationId (continue a thread) or spaceId (start
  // a new conversation in that space).
  conversationId?: string;
  spaceId?: string;
  userText: string;
  // Wired from the client disconnect by the route (R27).
  signal?: AbortSignal;
  // Test seam: override the user's display name for `{{user.name}}` (R20).
  userName?: string;
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
    const conversation = await createConversation(space.id);
    return { conversationId: conversation.id, space, history: [] };
  }

  throw new Error("runTurn requires either conversationId or spaceId.");
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
 * Run a grounded chat turn, yielding events as they happen (R16–R30).
 *
 * Flow (chat-turn lifecycle):
 *  1. Resolve conversation + space + history.
 *  2. query CyborgDB (topK). On error → RetrievalError, NO Ollama call (R25).
 *  3. Filter hits to similarity >= space.similarityThreshold. None → persist the
 *     user message + a no-sources assistant message and yield `no-sources` (R18).
 *  4. Else emit `sources` (rail candidates), compose the prompt (R20/R26/R29),
 *     stream Ollama, relay `token`s.
 *  5. After the stream: validate citations, persist the user message + assistant
 *     message with the R30 snapshot, yield `done`.
 *
 * Cancellation (R27): if the signal aborts mid-stream, the upstream fetch is
 * aborted, the error propagates, and NO partial assistant message is persisted.
 */
export async function* runTurn(
  input: RunTurnInput,
): AsyncGenerator<TurnEvent, void, unknown> {
  const { conversationId, space, history } = await resolveTarget(input);
  const topK = input.topK ?? DEFAULT_TOP_K;
  const spaceRef = toSpaceRef(space);

  // 2. Retrieve. A failure here is R25 — never fall through to Ollama.
  let hits: CyborgHit[];
  try {
    hits = await query(spaceRef, input.userText, topK);
  } catch (error) {
    throw new RetrievalError(error);
  }

  // 3. Filter to usable hits (similarity >= per-space threshold, KTD8).
  const usable = hits.filter((h) => h.similarity >= space.similarityThreshold);

  if (usable.length === 0) {
    // No-sources turn (R18): persist the exchange, never call the model.
    await appendMessage(conversationId, { role: "user", text: input.userText });
    await appendMessage(conversationId, {
      role: "assistant",
      text: NO_SOURCES_MESSAGE,
      sources: [],
    });
    yield { type: "no-sources", conversationId, message: NO_SOURCES_MESSAGE };
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
  });

  // Stream tokens, accumulating the full answer for post-stream citation
  // validation. A mid-stream abort throws out of the generator before any
  // persistence (R27: no partial persisted).
  let answer = "";
  for await (const token of streamChat({
    url: settings.ollamaUrl,
    model: settings.chatModel,
    messages: composed.messages,
    signal: input.signal,
  })) {
    answer += token;
    yield { type: "token", value: token };
  }

  // 5. Validate citations against the usable set and persist (R17/R30).
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
  };
}
