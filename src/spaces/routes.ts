// Knowledge space API plugin (U6). Exposes space CRUD, the custom-prompt
// editor, and per-space conversation history. Requirements R3, R7, R19, R20.
//
// NOTE: the orchestrator mounts this plugin inside the authenticated scope and
// applies the auth guard — this module exports only the plugin and does not
// register auth itself. Routes use full `/api/*` paths, so mount without a
// prefix.

import type { FastifyInstance } from "fastify";
import {
  requireSpaceRole,
  requireWorkspaceRole,
  spaceFromConversation,
  spaceFromParam,
} from "../auth/space-guard.js";
import {
  appendMessage,
  createConversation,
  createSpace,
  deleteSpace,
  getConversation,
  getSpace,
  listConversations,
  listDocuments,
  listSpacesForUser,
  publicSpace,
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
  // List spaces visible to the caller (R7): all for admin/owner, member spaces
  // otherwise. indexKey stripped — never crosses the API boundary (R29/R8).
  app.get("/api/spaces", async (request) => {
    const user = request.user!;
    return (await listSpacesForUser(user.id, user.workspaceRole)).map(publicSpace);
  });

  // Create a space (provisions its CyborgDB index, R7). Admin/owner only.
  app.post("/api/spaces", { preHandler: requireWorkspaceRole("admin") }, async (request, reply) => {
    const body = (request.body ?? {}) as CreateSpaceBody;
    if (typeof body.name !== "string" || body.name.trim().length === 0) {
      return reply.code(400).send({ error: "A non-empty name is required." });
    }
    const space = await createSpace({ name: body.name });
    return reply.code(201).send(publicSpace(space));
  });

  // Delete a space (tears down its index, then cascades rows, R7). Admin/owner only.
  app.delete("/api/spaces/:id", { preHandler: requireWorkspaceRole("admin") }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const space = await getSpace(id);
    if (!space) {
      return reply.code(404).send({ error: "Space not found." });
    }
    await deleteSpace(id);
    return reply.code(204).send();
  });

  // Update the raw custom-prompt template (R20). Editor+ on the space.
  app.put("/api/spaces/:id/prompt", { preHandler: requireSpaceRole("editor", spaceFromParam) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as PromptBody;
    if (typeof body.prompt !== "string") {
      return reply.code(400).send({ error: "prompt must be a string." });
    }
    const space = await getSpace(id);
    if (!space) {
      return reply.code(404).send({ error: "Space not found." });
    }
    const updated = await updateCustomPrompt(id, body.prompt);
    return reply.code(200).send({ customPrompt: updated.customPrompt });
  });

  // List the documents currently indexed in a space (files in context). Viewer+.
  app.get("/api/spaces/:id/documents", { preHandler: requireSpaceRole("viewer", spaceFromParam) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const space = await getSpace(id);
    if (!space) {
      return reply.code(404).send({ error: "Space not found." });
    }
    return listDocuments(id);
  });

  // List a space's conversations (R19). Viewer+.
  app.get("/api/spaces/:id/conversations", { preHandler: requireSpaceRole("viewer", spaceFromParam) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const space = await getSpace(id);
    if (!space) {
      return reply.code(404).send({ error: "Space not found." });
    }
    return listConversations(id);
  });

  // Start a new conversation in a space (R19). Viewer+ (viewers may chat).
  app.post("/api/spaces/:id/conversations", { preHandler: requireSpaceRole("viewer", spaceFromParam) }, async (request, reply) => {
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

  // Reopen a conversation with its messages (R19). Viewer+ on its space.
  app.get("/api/conversations/:id", { preHandler: requireSpaceRole("viewer", spaceFromConversation) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const conversation = await getConversation(id);
    if (!conversation) {
      return reply.code(404).send({ error: "Conversation not found." });
    }
    return conversation;
  });
}
