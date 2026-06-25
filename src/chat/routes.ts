// Chat SSE API plugin (U10). Opens a Server-Sent Events stream for a chat turn
// and relays the orchestrator's events as named SSE frames.
//
// Requirements: R16/R17/R18/R19/R25/R27/R30. The orchestrator (orchestrator.ts)
// owns the RAG logic; this module is the transport adapter only.
//
// SSE event shapes (each frame is `event: <name>\ndata: <json>\n\n`):
//   - `sources`         data: { cards: SourceCard[] }      (rail candidates, at stream start)
//   - `token`           data: { value: string }            (one per streamed chunk)
//   - `error`           data: { kind, message }            (R18 no-sources / R25 retrieval-error / generic)
//   - `done`            data: { conversationId, cited, dropped, cards }
//
// The R18 no-sources case and the R25 retrieval-error case are surfaced as
// distinct `error` event *kinds* ("no-sources" vs "retrieval-error") so the
// client renders them as different states (R18 vs R25 must be distinguishable).
//
// NOTE: the orchestrator mounts this plugin inside the authenticated scope and
// applies the auth guard; routes use full `/api/*` paths, so mount without a
// prefix.

import type { FastifyInstance, FastifyReply } from "fastify";
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
  app.post("/api/conversations/:id/messages", async (request, reply) => {
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
        userName: (request as { user?: { name?: string } }).user?.name,
      })) {
        switch (event.type) {
          case "sources":
            write(reply, "sources", { cards: event.cards });
            break;
          case "token":
            write(reply, "token", { value: event.value });
            break;
          case "no-sources":
            // R18: distinct error kind, no answer streamed.
            write(reply, "error", {
              kind: "no-sources",
              message: event.message,
              conversationId: event.conversationId,
            });
            break;
          case "done":
            write(reply, "done", {
              conversationId: event.conversationId,
              cited: event.cited,
              dropped: event.dropped,
              cards: event.cards,
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
