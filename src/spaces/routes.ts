// Knowledge space API plugin (U6). Exposes space CRUD, the custom-prompt
// editor, and per-space conversation history. Requirements R3, R7, R19, R20.
//
// NOTE: the orchestrator mounts this plugin inside the authenticated scope and
// applies the auth guard — this module exports only the plugin and does not
// register auth itself. Routes use full `/api/*` paths, so mount without a
// prefix.

import type { FastifyInstance } from "fastify";
import {
  appendMessage,
  createConversation,
  createSpace,
  deleteSpace,
  getConversation,
  getSpace,
  listConversations,
  listSpaces,
  updateCustomPrompt,
} from "./service.js";

interface CreateSpaceBody {
  name?: unknown;
}

interface PromptBody {
  prompt?: unknown;
}

interface CreateConversationBody {
  title?: unknown;
}

export default async function spacesRoutes(app: FastifyInstance): Promise<void> {
  // List all spaces.
  app.get("/api/spaces", async () => {
    return listSpaces();
  });

  // Create a space (provisions its CyborgDB index, R7).
  app.post("/api/spaces", async (request, reply) => {
    const body = (request.body ?? {}) as CreateSpaceBody;
    if (typeof body.name !== "string" || body.name.trim().length === 0) {
      return reply.code(400).send({ error: "A non-empty name is required." });
    }
    const space = await createSpace({ name: body.name });
    return reply.code(201).send(space);
  });

  // Delete a space (tears down its index, then cascades rows, R7).
  app.delete("/api/spaces/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const space = await getSpace(id);
    if (!space) {
      return reply.code(404).send({ error: "Space not found." });
    }
    await deleteSpace(id);
    return reply.code(204).send();
  });

  // Update the raw custom-prompt template (R20).
  app.put("/api/spaces/:id/prompt", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as PromptBody;
    if (typeof body.prompt !== "string") {
      return reply.code(400).send({ error: "prompt must be a string." });
    }
    const space = await getSpace(id);
    if (!space) {
      return reply.code(404).send({ error: "Space not found." });
    }
    return updateCustomPrompt(id, body.prompt);
  });

  // List a space's conversations (R19).
  app.get("/api/spaces/:id/conversations", async (request, reply) => {
    const { id } = request.params as { id: string };
    const space = await getSpace(id);
    if (!space) {
      return reply.code(404).send({ error: "Space not found." });
    }
    return listConversations(id);
  });

  // Start a new conversation in a space (R19).
  app.post("/api/spaces/:id/conversations", async (request, reply) => {
    const { id } = request.params as { id: string };
    const space = await getSpace(id);
    if (!space) {
      return reply.code(404).send({ error: "Space not found." });
    }
    const body = (request.body ?? {}) as CreateConversationBody;
    const title = typeof body.title === "string" ? body.title : undefined;
    const conversation = await createConversation(id, title);
    return reply.code(201).send(conversation);
  });

  // Reopen a conversation with its messages (R19).
  app.get("/api/conversations/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const conversation = await getConversation(id);
    if (!conversation) {
      return reply.code(404).send({ error: "Conversation not found." });
    }
    return conversation;
  });
}
