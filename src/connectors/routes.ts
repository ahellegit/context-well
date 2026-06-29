// Connector API plugin (U7). Exposes per-space connector CRUD, validation,
// target listing, and the user-triggered sync (R15). Credential values are
// NEVER returned to the browser — list/read responses mask them to a
// {set, last4} indicator (R29 / KTD12).
//
// NOTE: like the spaces plugin, this exports only the plugin and uses full
// `/api/*` paths; the orchestrator mounts it inside the authenticated scope.

import type { FastifyInstance } from "fastify";
import type { Connector } from "@prisma/client";
import { prisma } from "../db/client.js";
import {
  requireSpaceRole,
  spaceFromConnector,
  spaceFromParam,
} from "../auth/space-guard.js";
import { getSpace } from "../spaces/service.js";
import {
  deleteVectors,
  listIds,
  type SpaceRef,
} from "../cyborg/index-service.js";
import { getConnector } from "./registry.js";
import { SyncInProgressError, isSyncing, syncConnector } from "./sync.js";

interface AddConnectorBody {
  kind?: unknown;
  credentials?: unknown;
  targets?: unknown;
}

interface ValidateBody {
  credentials?: unknown;
}

/**
 * Public, browser-safe view of a connector: credentials are masked to a
 * set/last-4 indicator (R29). The raw token never crosses the API boundary.
 */
function maskCredentials(creds: string): { set: boolean; last4: string } {
  const trimmed = (creds ?? "").trim();
  return {
    set: trimmed.length > 0,
    last4: trimmed.length >= 4 ? trimmed.slice(-4) : "",
  };
}

function toPublic(c: Connector): Record<string, unknown> {
  return {
    id: c.id,
    spaceId: c.spaceId,
    kind: c.kind,
    credentials: maskCredentials(c.credentials),
    targets: safeParse(c.targets, []),
    status: c.status,
    detail: c.detail,
    lastSyncAt: c.lastSyncAt,
    chunkCount: c.chunkCount,
    syncing: isSyncing(c.spaceId),
  };
}

function safeParse(json: string, fallback: unknown): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}

function spaceRef(space: {
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

export default async function connectorsRoutes(
  app: FastifyInstance,
): Promise<void> {
  // List a space's connectors (credentials masked, R29). Viewer+ (read).
  app.get("/api/spaces/:id/connectors", { preHandler: requireSpaceRole("viewer", spaceFromParam) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const space = await getSpace(id);
    if (!space) return reply.code(404).send({ error: "Space not found." });

    const connectors = await prisma.connector.findMany({
      where: { spaceId: id },
      orderBy: { id: "asc" },
    });
    return connectors.map(toPublic);
  });

  // Add a connector to a space (R14). Stores credentials server-side; the
  // response is masked. Editor+ on the space.
  app.post("/api/spaces/:id/connectors", { preHandler: requireSpaceRole("editor", spaceFromParam) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const space = await getSpace(id);
    if (!space) return reply.code(404).send({ error: "Space not found." });

    const body = (request.body ?? {}) as AddConnectorBody;
    if (typeof body.kind !== "string" || body.kind.length === 0) {
      return reply.code(400).send({ error: "kind is required." });
    }
    if (!getConnector(body.kind)) {
      return reply
        .code(400)
        .send({ error: `Unknown connector kind "${body.kind}".` });
    }
    const credentials =
      typeof body.credentials === "string" ? body.credentials : "";
    const targets = Array.isArray(body.targets)
      ? JSON.stringify(body.targets.map(String))
      : "[]";

    const connector = await prisma.connector.create({
      data: { spaceId: id, kind: body.kind, credentials, targets },
    });
    return reply.code(201).send(toPublic(connector));
  });

  // Validate a connector's credentials (R29 scope check lives in the impl).
  // Accepts optional credentials in the body to validate before saving;
  // otherwise validates the stored credentials.
  app.post("/api/connectors/:id/validate", { preHandler: requireSpaceRole("editor", spaceFromConnector) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const connector = await prisma.connector.findUnique({ where: { id } });
    if (!connector) return reply.code(404).send({ error: "Connector not found." });

    const impl = getConnector(connector.kind);
    if (!impl) {
      return reply
        .code(400)
        .send({ error: `No connector registered for kind "${connector.kind}".` });
    }

    const body = (request.body ?? {}) as ValidateBody;
    const creds =
      typeof body.credentials === "string" && body.credentials.length > 0
        ? body.credentials
        : connector.credentials;

    const result = await impl.validate(creds);
    // Persist the auth state so the UI reflects it without re-validating.
    await prisma.connector.update({
      where: { id },
      data: { status: result.ok ? "idle" : "auth_error" },
    });
    return result;
  });

  // List the targets a connector's credentials can ingest.
  app.get("/api/connectors/:id/targets", { preHandler: requireSpaceRole("editor", spaceFromConnector) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const connector = await prisma.connector.findUnique({ where: { id } });
    if (!connector) return reply.code(404).send({ error: "Connector not found." });

    const impl = getConnector(connector.kind);
    if (!impl) {
      return reply
        .code(400)
        .send({ error: `No connector registered for kind "${connector.kind}".` });
    }
    return impl.listTargets(connector.credentials);
  });

  // Trigger a sync (R15). 409 when a sync already holds the space lock (R24).
  // Editor+ on the connector's space (ingest is a write).
  app.post("/api/connectors/:id/sync", { preHandler: requireSpaceRole("editor", spaceFromConnector) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const connector = await prisma.connector.findUnique({ where: { id } });
    if (!connector) return reply.code(404).send({ error: "Connector not found." });

    try {
      const result = await syncConnector(id);
      return result;
    } catch (error) {
      if (error instanceof SyncInProgressError) {
        return reply
          .code(409)
          .send({ error: "A sync is already in progress for this space." });
      }
      throw error;
    }
  });

  // Delete a connector and purge its vectors from the index (R23 cleanup).
  // Editor+ on the connector's space.
  app.delete("/api/connectors/:id", { preHandler: requireSpaceRole("editor", spaceFromConnector) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const connector = await prisma.connector.findUnique({ where: { id } });
    if (!connector) return reply.code(404).send({ error: "Connector not found." });

    const space = await getSpace(connector.spaceId);
    if (space) {
      // Purge only this connector's vectors: index IDs owned by its documents.
      const owned = (
        await prisma.documentVector.findMany({
          where: { document: { connectorId: id } },
          select: { vectorId: true },
        })
      ).map((v) => v.vectorId);

      if (owned.length > 0) {
        try {
          // Intersect with the index ground truth so we only delete what exists.
          const ref = spaceRef(space);
          const present = new Set(await listIds(ref));
          const toDelete = owned.filter((vid) => present.has(vid));
          if (toDelete.length > 0) await deleteVectors(ref, toDelete);
        } catch {
          // Best-effort purge: a failed index delete should not block removing
          // the connector row. Orphaned vectors are reconciled on next sync.
        }
      }
    }

    // Cascade removes Document + DocumentVector rows.
    await prisma.connector.delete({ where: { id } });
    return reply.code(204).send();
  });
}
