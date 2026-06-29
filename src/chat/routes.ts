// Chat SSE API plugin (U10). Opens a Server-Sent Events stream for a chat turn
// and relays the orchestrator's events as named SSE frames.
//
// Requirements: R16/R17/R18/R19/R25/R27/R30. The orchestrator (orchestrator.ts)
// owns the RAG logic; this module is the transport adapter only.
//
// SSE event shapes (each frame is `event: <name>\ndata: <json>\n\n`):
//   - `sources`         data: { cards: SourceCard[] }      (rail candidates, at stream start; [] when ungrounded)
//   - `notice`          data: { message }                  (hybrid: no sources matched, answer is ungrounded)
//   - `token`           data: { value: string }            (one per streamed chunk)
//   - `error`           data: { kind, message }            (R25 retrieval-error / generic stream failure)
//   - `done`            data: { conversationId, cited, dropped, cards, grounded }
//
// A genuine CyborgDB *failure* (R25) is surfaced as an `error` event with kind
// "retrieval-error" and never an answer. An empty result is NOT an error: the
// turn falls back to general chat (a `notice` then streamed tokens), with
// `done.grounded:false` so the client can label the answer as ungrounded.
//
// NOTE: the orchestrator mounts this plugin inside the authenticated scope and
// applies the auth guard; routes use full `/api/*` paths, so mount without a
// prefix.

import type { FastifyInstance, FastifyReply } from "fastify";
import { requireSpaceRole, spaceFromConversation } from "../auth/space-guard.js";
import { runTurn, RetrievalError } from "./orchestrator.js";

interface MessageBody {
  text?: unknown;
}

// Serialize one SSE frame. `data` is JSON-encoded on a single line.
function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function write(reply: FastifyReply, event: string, data: unknown): void {
  reply.raw.write(sseFrame(event, data));
}

export default async function chatRoutes(app: FastifyInstance): Promise<void> {
  // Post a message to a conversation and stream the grounded answer (R16/R27).
  // Viewer+ on the conversation's space (viewers may chat).
  app.post(
    "/api/conversations/:id/messages",
    { preHandler: requireSpaceRole("viewer", spaceFromConversation) },
    async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as MessageBody;

    if (typeof body.text !== "string" || body.text.trim().length === 0) {
      return reply.code(400).send({ error: "A non-empty text is required." });
    }

    // Open the SSE stream. Hijack the reply so Fastify does not also try to send
    // a body — we own reply.raw from here on.
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

    // Wire the client disconnect to an abort signal (R27): a dropped connection
    // aborts the upstream Ollama request via the orchestrator.
    const controller = new AbortController();
    const onClose = () => controller.abort(new Error("client disconnected"));
    request.raw.on("close", onClose);

    try {
      for await (const event of runTurn({
        conversationId: id,
        userText: body.text,
        signal: controller.signal,
        userName: request.user?.email,
      })) {
        switch (event.type) {
          case "sources":
            write(reply, "sources", { cards: event.cards });
            break;
          case "token":
            write(reply, "token", { value: event.value });
            break;
          case "notice":
            // Hybrid: no sources matched; the streamed answer is ungrounded.
            write(reply, "notice", { message: event.message });
            break;
          case "done":
            write(reply, "done", {
              conversationId: event.conversationId,
              cited: event.cited,
              dropped: event.dropped,
              cards: event.cards,
              grounded: event.grounded,
              timing: event.timing,
            });
            break;
        }
      }
    } catch (error) {
      // R25 retrieval failure is a distinct error kind from a generic stream
      // failure; both are surfaced (never an ungrounded answer). A client-abort
      // (R27) leaves no partial persisted; we still emit a frame if writable.
      const kind = error instanceof RetrievalError ? "retrieval-error" : "error";
      const message =
        error instanceof Error ? error.message : "Chat failed unexpectedly.";
      if (!reply.raw.writableEnded) {
        write(reply, "error", { kind, message });
      }
    } finally {
      request.raw.off("close", onClose);
      if (!reply.raw.writableEnded) reply.raw.end();
    }
  });
}
