// Settings API plugin. Exposes the persisted Ollama URL + chat
// model and a test-connection probe for the setup wizard.
//
// NOTE: the orchestrator mounts this plugin and applies the auth guard — this
// module exports only the plugin and does not register auth itself. Routes use
// full `/api/settings*` paths, so mount without a prefix.

import type { FastifyInstance } from "fastify";
import { getSettings, updateSettings, isConfigured } from "./service.js";
import { testConnection } from "../ollama/client.js";
import { requireWorkspaceRole, isWorkspaceAdmin } from "../auth/space-guard.js";

interface UpdateBody {
  ollamaUrl?: unknown;
  chatModel?: unknown;
}

interface TestBody {
  url?: unknown;
}

export default async function settingsRoutes(app: FastifyInstance): Promise<void> {
  // Current settings + whether first-run setup is complete. Available to any
  // authenticated user (the frontend needs `isConfigured` to route to the app
  // vs. the setup wizard), but `ollamaUrl` is admin/owner-only: on a self-hosted
  // deploy it is typically an internal address, so it must not leak to a plain
  // member. Only admins/owners can set it (PUT below), so only they see it.
  app.get("/api/settings", async (request) => {
    const [settings, configured] = await Promise.all([
      getSettings(),
      isConfigured(),
    ]);
    const { ollamaUrl, ...rest } = settings;
    const visible = isWorkspaceAdmin(request.user?.workspaceRole)
      ? { ...rest, ollamaUrl }
      : rest;
    return { ...visible, isConfigured: configured };
  });

  // Persist the Ollama URL and/or chat model. Admin/owner only — this is a
  // workspace-global setting and the orchestrator sends every user's chat turn
  // (prompt + retrieved source content) to the configured URL, so a low-privilege
  // user must not be able to repoint it.
  app.put("/api/settings", { preHandler: requireWorkspaceRole("admin") }, async (request, reply) => {
    const body = (request.body ?? {}) as UpdateBody;

    const patch: { ollamaUrl?: string; chatModel?: string } = {};
    if (body.ollamaUrl !== undefined) {
      if (typeof body.ollamaUrl !== "string") {
        return reply.code(400).send({ error: "ollamaUrl must be a string." });
      }
      patch.ollamaUrl = body.ollamaUrl;
    }
    if (body.chatModel !== undefined) {
      if (typeof body.chatModel !== "string") {
        return reply.code(400).send({ error: "chatModel must be a string." });
      }
      patch.chatModel = body.chatModel;
    }

    const settings = await updateSettings(patch);
    const configured = await isConfigured();
    return { ...settings, isConfigured: configured };
  });

  // Test reachability + discover chat models (SSRF-guarded in the client).
  // Admin/owner only — server-side fetch to a caller-supplied URL.
  app.post("/api/settings/test-ollama", { preHandler: requireWorkspaceRole("admin") }, async (request, reply) => {
    const body = (request.body ?? {}) as TestBody;
    if (typeof body.url !== "string" || body.url.trim().length === 0) {
      return reply.code(400).send({ error: "A url string is required." });
    }
    return testConnection(body.url);
  });
}
