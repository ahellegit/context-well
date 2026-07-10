// Knowledge space API plugin. Exposes space CRUD, the custom-prompt
// editor, and per-space conversation history.
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
import { listSpaceMembers } from "../members/service.js";
import { IndexLockedError } from "../cyborg/index-service.js";
import { buildSpaceGraph, getDocGraph } from "./graph.js";
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
  // List spaces visible to the caller: all for admin/owner, member spaces
  // otherwise. indexKey stripped — never crosses the API boundary.
  app.get("/api/spaces", async (request) => {
    const user = request.user!;
    return (await listSpacesForUser(user.id, user.workspaceRole)).map(publicSpace);
  });

  // Create a space (provisions its CyborgDB index). Admin/owner only.
  app.post("/api/spaces", { preHandler: requireWorkspaceRole("admin") }, async (request, reply) => {
    const body = (request.body ?? {}) as CreateSpaceBody;
    if (typeof body.name !== "string" || body.name.trim().length === 0) {
      return reply.code(400).send({ error: "A non-empty name is required." });
    }
    const space = await createSpace({ name: body.name });
    return reply.code(201).send(publicSpace(space));
  });

  // Delete a space (tears down its index, then cascades rows). Admin/owner only.
  app.delete("/api/spaces/:id", { preHandler: requireWorkspaceRole("admin") }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const space = await getSpace(id);
    if (!space) {
      return reply.code(404).send({ error: "Space not found." });
    }
    await deleteSpace(id);
    return reply.code(204).send();
  });

  // Update the raw custom-prompt template. Editor+ on the space.
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

  // List a space's members + roles (per-space access management). Admin/owner only.
  app.get("/api/spaces/:id/members", { preHandler: requireWorkspaceRole("admin") }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const space = await getSpace(id);
    if (!space) {
      return reply.code(404).send({ error: "Space not found." });
    }
    return listSpaceMembers(id);
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

  // SPIKE: on-the-fly similarity graph of a space's chunks, for the graph
  // explorer at /graph.html. Read-only, viewer+. Reuses the space's cosine
  // index — no new store. Query params: ?nodes= &k= &threshold=.
  app.get("/api/spaces/:id/graph", { preHandler: requireSpaceRole("viewer", spaceFromParam) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const space = await getSpace(id);
    if (!space) {
      return reply.code(404).send({ error: "Space not found." });
    }
    const q = request.query as {
      nodes?: string;
      k?: string;
      threshold?: string;
      level?: string;
      refresh?: string;
    };
    const num = (v: string | undefined): number | undefined =>
      v != null && v !== "" && !Number.isNaN(Number(v)) ? Number(v) : undefined;
    try {
      // Document-level map (Sources view, cached) vs chunk-level graph (page).
      if (q.level === "document") {
        return await getDocGraph(
          space,
          {
            maxDocs: num(q.nodes),
            neighbors: num(q.k),
            threshold: num(q.threshold),
          },
          q.refresh === "1",
        );
      }
      return await buildSpaceGraph(space, {
        maxNodes: num(q.nodes),
        neighbors: num(q.k),
        threshold: num(q.threshold),
      });
    } catch (error) {
      // A locked/unopenable index is a known, reportable state — not a 500.
      if (error instanceof IndexLockedError) {
        return reply.code(423).send({ error: error.message });
      }
      throw error;
    }
  });

  // List a space's conversations. Viewer+.
  app.get("/api/spaces/:id/conversations", { preHandler: requireSpaceRole("viewer", spaceFromParam) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const space = await getSpace(id);
    if (!space) {
      return reply.code(404).send({ error: "Space not found." });
    }
    // Private: only the caller's own conversations in this space.
    return listConversations(id, request.user!.id);
  });

  // Start a new conversation in a space. Viewer+ (viewers may chat).
  app.post("/api/spaces/:id/conversations", { preHandler: requireSpaceRole("viewer", spaceFromParam) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const space = await getSpace(id);
    if (!space) {
      return reply.code(404).send({ error: "Space not found." });
    }
    const body = (request.body ?? {}) as CreateConversationBody;
    const title = typeof body.title === "string" ? body.title : undefined;
    // Owned by the creator — the only person who can later see it.
    const conversation = await createConversation(id, request.user!.id, title);
    return reply.code(201).send(conversation);
  });

  // Reopen a conversation with its messages. Viewer+ on its space AND the
  // caller must own it — conversations are private (a non-owner gets 404, no oracle).
  app.get("/api/conversations/:id", { preHandler: requireSpaceRole("viewer", spaceFromConversation) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const conversation = await getConversation(id, request.user!.id);
    if (!conversation) {
      return reply.code(404).send({ error: "Conversation not found." });
    }
    return conversation;
  });
}
