// Settings API plugin (R28, KTD11). Exposes the persisted Ollama URL + chat
// model and a test-connection probe for the setup wizard.
//
// NOTE: the orchestrator mounts this plugin and applies the auth guard — this
// module exports only the plugin and does not register auth itself. Routes use
// full `/api/settings*` paths, so mount without a prefix.

import type { FastifyInstance } from "fastify";
import { getSettings, updateSettings, isConfigured } from "./service.js";
import { testConnection } from "../ollama/client.js";

interface UpdateBody {
  ollamaUrl?: unknown;
  chatModel?: unknown;
}

interface TestBody {
  url?: unknown;
}

export default async function settingsRoutes(app: FastifyInstance): Promise<void> {
  // Current settings + whether first-run setup is complete.
  app.get("/api/settings", async () => {
    const [settings, configured] = await Promise.all([
      getSettings(),
      isConfigured(),
    ]);
    return { ...settings, isConfigured: configured };
  });

  // Persist the Ollama URL and/or chat model.
  app.put("/api/settings", async (request, reply) => {
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
  app.post("/api/settings/test-ollama", async (request, reply) => {
    const body = (request.body ?? {}) as TestBody;
    if (typeof body.url !== "string" || body.url.trim().length === 0) {
      return reply.code(400).send({ error: "A url string is required." });
    }
    return testConnection(body.url);
  });
}
