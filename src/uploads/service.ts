// File upload ingestion (text/markdown/code). Lets a user seed a knowledge
// space's vector index directly from uploaded text files — no GitHub/Slack
// token required — so grounded chat works against an upload-only corpus.
//
// Uploads are modeled as a single per-space connector row of kind "upload":
// this reuses the connector DELETE route's vector purge (listIds ∩ owned) and
// surfaces uploaded files in the Sources list alongside github/slack.
//
// Ingestion mirrors the sync pipeline (src/connectors/sync.ts): chunk each
// file's text with the shared chunkText helper, build stable chunk IDs (KTD7),
// upsert text-in to CyborgDB, and reconcile Document/DocumentVector rows. It
// runs under the per-space-index lock (withSpaceLock) so it can never race a
// connector sync — a concurrent sync surfaces as SyncInProgressError → HTTP 409.

import { prisma } from "../db/client.js";
import {
  deleteVectors,
  listIds,
  train,
  upsertChunks,
  type CyborgChunk,
  type SpaceRef,
} from "../cyborg/index-service.js";
import { getSpace } from "../spaces/service.js";
import { chunkId, chunkText } from "../connectors/chunk.js";
import { TRAIN_THRESHOLD, withSpaceLock } from "../connectors/sync.js";

// The connector `kind` reserved for uploaded files. One row per space.
export const UPLOAD_KIND = "upload";

/** A decoded upload: the original filename and its utf-8 text body. */
export interface UploadFile {
  filename: string;
  text: string;
}

export interface IngestedFile {
  name: string;
  chunks: number;
  documents: number;
}

export interface IngestResult {
  connectorId: string;
  files: IngestedFile[];
  totalChunks: number;
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

/** First ~200 chars of a body, collapsed to a single line for the source card. */
function snippetOf(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * Find the space's upload connector, creating it if absent. The row is a normal
 * Connector with kind "upload", no credentials, and no targets — its chunks are
 * supplied by uploads, not a sync.
 */
export async function ensureUploadConnector(spaceId: string) {
  const existing = await prisma.connector.findFirst({
    where: { spaceId, kind: UPLOAD_KIND },
  });
  if (existing) return existing;

  return prisma.connector.create({
    data: {
      spaceId,
      kind: UPLOAD_KIND,
      credentials: "",
      targets: "[]",
      status: "idle",
    },
  });
}

/**
 * Ingest a batch of decoded text files into a space's index. Runs under the
 * per-space lock so it cannot race a connector sync (a 409 surfaces if one is
 * running). Per-file replace semantics keep re-uploading a filename idempotent:
 * stable chunk IDs mean unchanged chunks keep their vectors, and chunks that
 * vanished (e.g. trailing windows of a now-shorter file) are purged.
 */
export async function ingestFiles(
  spaceId: string,
  files: UploadFile[],
): Promise<IngestResult> {
  return withSpaceLock(spaceId, async () => {
    const space = await getSpace(spaceId);
    if (!space) throw new Error(`Space ${spaceId} not found.`);
    const ref = spaceRef(space);

    const connector = await ensureUploadConnector(spaceId);

    const ingested: IngestedFile[] = [];
    let totalChunks = 0;

    for (const file of files) {
      const bodies = chunkText(file.text);
      const chunks: CyborgChunk[] = bodies.map((body, i) => ({
        id: chunkId(UPLOAD_KIND, file.filename, file.filename, i),
        contents: body,
        metadata: {
          connector: UPLOAD_KIND,
          title: file.filename,
          snippet: snippetOf(body),
          target: file.filename,
          ref: file.filename,
        },
      }));
      const newIds = new Set(chunks.map((c) => c.id));

      // Per-file replace: locate this file's existing Document, purge vectors
      // whose IDs no longer appear, then drop the row (cascades DocumentVector).
      const existingDoc = await prisma.document.findFirst({
        where: { connectorId: connector.id, externalRef: file.filename },
        include: { vectors: true },
      });
      if (existingDoc) {
        const stale = existingDoc.vectors
          .map((v) => v.vectorId)
          .filter((id) => !newIds.has(id));
        if (stale.length > 0) {
          // Best-effort: a failed delete leaves orphaned vectors the next
          // upload (or connector removal) reconciles; it must not abort ingest.
          try {
            await deleteVectors(ref, stale);
          } catch {
            // ignore
          }
        }
        await prisma.document.delete({ where: { id: existingDoc.id } });
      }

      await upsertChunks(ref, chunks);

      await prisma.document.create({
        data: {
          spaceId,
          connectorId: connector.id,
          externalRef: file.filename,
          title: file.filename,
          metadata: JSON.stringify({ connector: UPLOAD_KIND, target: file.filename }),
          vectors: { create: chunks.map((c) => ({ vectorId: c.id })) },
        },
      });

      totalChunks += chunks.length;
      ingested.push({ name: file.filename, chunks: chunks.length, documents: 1 });
    }

    // The connector's chunkCount is the total DocumentVector count it owns.
    const chunkCount = await prisma.documentVector.count({
      where: { document: { connectorId: connector.id } },
    });
    await prisma.connector.update({
      where: { id: connector.id },
      data: { status: "connected", chunkCount, lastSyncAt: new Date() },
    });

    // Train past the threshold (exhaustive → ANN); best-effort like sync.
    try {
      if ((await listIds(ref)).length >= TRAIN_THRESHOLD) {
        await train(ref);
      }
    } catch {
      // Training is an optimization; a failure does not fail the upload.
    }

    return { connectorId: connector.id, files: ingested, totalChunks };
  });
}
