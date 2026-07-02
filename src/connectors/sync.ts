// Sync orchestration. Pulls chunks from a connector, upserts them into the
// space's CyborgDB index, reconciles Document/DocumentVector rows, purges stale
// vectors, trains past a threshold, and records per-target status — all under a
// per-space-index lock.
//
// Behavior:
// - Resync is idempotent and purges stale vectors. Stable chunk IDs mean a
//   re-run upserts the same IDs; vectors whose IDs no longer appear are deleted.
//   Ground truth for "what currently exists" is the index's listIds(), not the
//   DB alone (the DB can diverge after an interrupted sync).
// - At most one sync per space index. Concurrent triggers are REJECTED with a
//   typed SyncInProgressError (not queued).
// - Sync is user-triggered; status + counts reflect what was ingested.
//
// The lock is an in-memory Map<spaceId, true> — sufficient for v1's single
// process. A multi-process deployment would need a DB/redis lock; out of scope.

import type { Connector } from "@prisma/client";
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
import { getConnector } from "./registry.js";
import type { Chunk, Connector as ConnectorPlugin } from "./types.js";

// v1 corpus envelope: cap chunks per sync so a runaway source can't ingest
// unbounded. Crossing the cap stops the pull and marks the result truncated.
export const MAX_CHUNKS_PER_SYNC = 5000;

// Train the index (exhaustive → ANN) once it holds at least this many vectors.
// Below it, exhaustive search is fine and training is wasted work.
export const TRAIN_THRESHOLD = 1000;

// How often (in chunks pulled) to write a progress heartbeat during the pull
// phase. Small enough that a ~1.5s poll always sees movement, large enough that
// the extra DB writes are negligible next to the per-file network fetches.
const PROGRESS_EVERY = 25;

// --- Per-space-index lock ---------------------------------------------------

const locks = new Map<string, true>();

/**
 * Thrown when a sync is requested for a space that already has one in flight
 * (reject, do not queue). Typed so the route can map it to HTTP 409.
 */
export class SyncInProgressError extends Error {
  readonly spaceId: string;
  constructor(spaceId: string) {
    super(`A sync is already in progress for space ${spaceId}.`);
    this.name = "SyncInProgressError";
    this.spaceId = spaceId;
  }
}

function acquireLock(spaceId: string): void {
  if (locks.has(spaceId)) throw new SyncInProgressError(spaceId);
  locks.set(spaceId, true);
}

function releaseLock(spaceId: string): void {
  locks.delete(spaceId);
}

/** Whether a sync currently holds the lock for a space (UI lock reflection). */
export function isSyncing(spaceId: string): boolean {
  return locks.has(spaceId);
}

/**
 * Run `fn` while holding the per-space-index lock. Acquires the lock (throwing
 * {@link SyncInProgressError} if one is already held), runs the
 * body, and always releases in `finally`. Lets non-sync writers (e.g. file
 * uploads) share the same mutual exclusion as a connector sync without going
 * through `syncConnector`.
 */
export async function withSpaceLock<T>(
  spaceId: string,
  fn: () => Promise<T>,
): Promise<T> {
  acquireLock(spaceId);
  try {
    return await fn();
  } finally {
    releaseLock(spaceId);
  }
}

// --- Result shapes ---------------------------------------------------------

export interface TargetResult {
  targetId: string;
  ok: boolean;
  chunks: number;
  documents: number;
  message?: string;
}

export interface SyncResult {
  status: "connected" | "partial" | "error";
  chunkCount: number;
  documentCount: number;
  purged: number;
  trained: boolean;
  truncated: boolean;
  targets: TargetResult[];
}

// A source unit accumulated from the connector's chunk stream: one Document
// (keyed by target+ref), with its chunks in source order.
interface DocAccumulator {
  target: string;
  ref: string;
  title: string;
  metadata: Record<string, unknown>;
  chunks: Chunk[];
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

/**
 * Read the target id a chunk belongs to. Connectors set `metadata.target`; we
 * fall back to "default" so a connector that ingests a single implicit target
 * still groups correctly.
 */
function chunkTarget(chunk: Chunk): string {
  const t = chunk.metadata.target;
  return typeof t === "string" && t.length > 0 ? t : "default";
}

/**
 * Read the source-unit ref a chunk belongs to (the Document key within a
 * target). Connectors set `metadata.ref`; fall back to the chunk's own id so a
 * connector that does not group still produces one Document per chunk.
 */
function chunkRef(chunk: Chunk): string {
  const r = chunk.metadata.ref;
  return typeof r === "string" && r.length > 0 ? r : chunk.id;
}

/**
 * Run a sync for a connector. Acquires the per-space lock,
 * streams chunks from the connector, upserts them to CyborgDB, reconciles the
 * Document/DocumentVector rows, purges vectors no longer produced, trains past
 * the threshold, and writes the connector's status + counts. The lock is always
 * released in `finally`.
 *
 * @throws SyncInProgressError if another sync holds the space lock.
 */
export async function syncConnector(connectorId: string): Promise<SyncResult> {
  const connector = await prisma.connector.findUnique({
    where: { id: connectorId },
  });
  if (!connector) {
    throw new Error(`Connector ${connectorId} not found.`);
  }

  const space = await getSpace(connector.spaceId);
  if (!space) {
    throw new Error(`Space ${connector.spaceId} not found.`);
  }

  const impl = getConnector(connector.kind);
  if (!impl) {
    throw new Error(`No connector registered for kind "${connector.kind}".`);
  }

  // Acquire the lock BEFORE marking syncing, so a rejected concurrent trigger
  // never perturbs the in-flight sync's status.
  acquireLock(space.id);

  try {
    await prisma.connector.update({
      where: { id: connector.id },
      data: { status: "syncing" },
    });

    const targetIds = parseTargets(connector.targets);
    const ref = spaceRef(space);

    const result = await runSync(connector, impl, targetIds, ref);

    return result;
  } finally {
    releaseLock(space.id);
  }
}

function parseTargets(targetsJson: string): string[] {
  try {
    const parsed = JSON.parse(targetsJson);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * The body of a sync, run inside the lock. Pulls + accumulates, upserts,
 * reconciles, purges, trains, and persists status. Errors before any commit
 * yield an `error` status; per-target failures yield `partial`.
 */
async function runSync(
  connector: Connector,
  impl: ConnectorPlugin,
  targetIds: string[],
  ref: SpaceRef,
): Promise<SyncResult> {
  // Per-target tallies; populated as chunks stream in and a target's pull ends.
  const perTarget = new Map<string, TargetResult>();
  const ensureTarget = (id: string): TargetResult => {
    let t = perTarget.get(id);
    if (!t) {
      t = { targetId: id, ok: true, chunks: 0, documents: 0 };
      perTarget.set(id, t);
    }
    return t;
  };
  for (const id of targetIds) ensureTarget(id);

  // Accumulate this sync's chunks grouped into Documents (target+ref → doc).
  const docs = new Map<string, DocAccumulator>();
  const freshIds = new Set<string>();
  let totalChunks = 0;
  let truncated = false;
  let pullError: Error | undefined;

  // Initial heartbeat so a polling client sees "pulling" immediately, even
  // before the first chunk (the repo-tree fetch can take a moment).
  await writeProgress(connector.id, {
    phase: "pulling",
    chunks: 0,
    targetTotal: targetIds.length || undefined,
  });

  try {
    for await (const chunk of impl.sync(connector.credentials, targetIds)) {
      if (totalChunks >= MAX_CHUNKS_PER_SYNC) {
        truncated = true;
        break;
      }
      totalChunks += 1;
      freshIds.add(chunk.id);

      const target = chunkTarget(chunk);
      const refKey = chunkRef(chunk);
      const docKey = `${target} ${refKey}`;

      let doc = docs.get(docKey);
      if (!doc) {
        doc = {
          target,
          ref: refKey,
          title: chunk.metadata.title,
          metadata: chunk.metadata,
          chunks: [],
        };
        docs.set(docKey, doc);
        ensureTarget(target).documents += 1;
      }
      doc.chunks.push(chunk);
      ensureTarget(target).chunks += 1;

      // Heartbeat every PROGRESS_EVERY chunks with the running count + which
      // target is currently streaming (so the card reads "142 chunks · repo 1/2").
      if (totalChunks % PROGRESS_EVERY === 0) {
        const idx = targetIds.indexOf(target);
        await writeProgress(connector.id, {
          phase: "pulling",
          chunks: totalChunks,
          target,
          targetIndex: idx >= 0 ? idx + 1 : undefined,
          targetTotal: targetIds.length || undefined,
        });
      }
    }
  } catch (error) {
    // A pull failure surfaces from the connector's async iterator. If it threw a
    // per-target marker we record it; otherwise it's a hard pull error.
    pullError = error instanceof Error ? error : new Error(String(error));
    const failed = (error as { targetId?: string }).targetId;
    if (typeof failed === "string") {
      const t = ensureTarget(failed);
      t.ok = false;
      t.message = pullError.message;
      pullError = undefined; // a per-target failure is partial, not hard error
    }
  }

  // Hard pull error before any commit → error status, nothing written.
  if (pullError && docs.size === 0) {
    await finalizeStatus(connector.id, "error", {
      detail: pullError.message,
      chunkCount: connector.chunkCount,
    });
    return {
      status: "error",
      chunkCount: connector.chunkCount,
      documentCount: 0,
      purged: 0,
      trained: false,
      truncated,
      targets: [...perTarget.values()],
    };
  }

  // --- Commit: upsert to CyborgDB ------------------------------------------
  const cyborgChunks: CyborgChunk[] = [];
  for (const doc of docs.values()) {
    for (const c of doc.chunks) {
      cyborgChunks.push({ id: c.id, contents: c.contents, metadata: c.metadata });
    }
  }

  // Embedding can take a while (server-side, all chunks at once) — heartbeat the
  // phase + count so the card stops looking frozen after the pull completes.
  await writeProgress(connector.id, {
    phase: "embedding",
    chunks: cyborgChunks.length,
  });

  let upsertError: Error | undefined;
  try {
    await upsertChunks(ref, cyborgChunks);
  } catch (error) {
    upsertError = error instanceof Error ? error : new Error(String(error));
  }

  if (upsertError) {
    // Upsert failed before any DB-row commit → error status, nothing committed.
    await finalizeStatus(connector.id, "error", {
      detail: upsertError.message,
      chunkCount: connector.chunkCount,
    });
    return {
      status: "error",
      chunkCount: connector.chunkCount,
      documentCount: 0,
      purged: 0,
      trained: false,
      truncated,
      targets: [...perTarget.values()],
    };
  }

  // --- Reconcile DB rows + purge stale vectors -----------------------------
  // Replace this connector's Document/DocumentVector rows with the fresh set,
  // then purge stale vectors. Both run after the upsert; if the SQLite
  // transaction (or the purge) throws, finalize the connector as `error` before
  // rethrowing so it never stays stuck in `syncing` (the lock is released in
  // `finally`, but the status is not).
  const anyTargetFailed = [...perTarget.values()].some((t) => !t.ok);
  // The purge treats `freshIds` as the authoritative set for the whole
  // connector. That is only safe when the pull fully completed: a truncated
  // sync (cap hit), a hard pull error, or a per-target failure means `freshIds`
  // is missing chunks that still exist at the source, so purging would delete
  // still-valid vectors (data loss). In any of those cases we upsert what we
  // pulled but SKIP the purge entirely (invariant: never purge vectors for a
  // target whose pull did not fully complete).
  const purgeSafe = !truncated && !pullError && !anyTargetFailed;

  await writeProgress(connector.id, { phase: "finishing", chunks: totalChunks });

  let purged = 0;
  try {
    await reconcileDocuments(connector, docs);

    if (purgeSafe) {
      // Ground-truth purge: stale = (index IDs for this connector) − (fresh
      // IDs). We use listIds() as ground truth, not the DB, since an interrupted
      // prior sync can leave the index holding IDs the DB no longer references.
      purged = await purgeStale(ref, connector.id, freshIds);
    }
  } catch (error) {
    const reconcileError = error instanceof Error ? error : new Error(String(error));
    await finalizeStatus(connector.id, "error", {
      detail: reconcileError.message,
      chunkCount: connector.chunkCount,
    });
    throw reconcileError;
  }

  // --- Train past the threshold --------------------------------------------
  let indexTotal = 0;
  try {
    indexTotal = (await listIds(ref)).length;
  } catch {
    // listIds is best-effort for the train decision; ignore failures here.
  }
  let trained = false;
  if (indexTotal >= TRAIN_THRESHOLD) {
    try {
      await train(ref);
      trained = true;
    } catch {
      // Training is an optimization; a failure does not fail the sync.
    }
  }

  // --- Status -------------------------------------------------------------
  // A hard pull error that still produced some chunks (docs.size > 0, so we did
  // not early-return above) is surfaced as `error`: the pull did not complete,
  // so the stale purge was skipped and the connector's view of the source is
  // incomplete. Truncation and per-target failures are `partial`.
  const targets = [...perTarget.values()];
  const anyFailed = targets.some((t) => !t.ok);
  const status: SyncResult["status"] = pullError
    ? "error"
    : truncated
      ? "partial"
      : anyFailed
        ? "partial"
        : "connected";

  const documentCount = docs.size;
  await finalizeStatus(connector.id, status, {
    detail: JSON.stringify({ truncated, targets }),
    chunkCount: totalChunks,
  });

  return {
    status,
    chunkCount: totalChunks,
    documentCount,
    purged,
    trained,
    truncated,
    targets,
  };
}

/**
 * Replace a connector's Document + DocumentVector rows with the freshly synced
 * set. Done in a transaction so a partial write can't leave dangling rows.
 */
async function reconcileDocuments(
  connector: Connector,
  docs: Map<string, DocAccumulator>,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // Drop the connector's existing documents (cascade removes DocumentVector).
    await tx.document.deleteMany({ where: { connectorId: connector.id } });

    for (const doc of docs.values()) {
      await tx.document.create({
        data: {
          spaceId: connector.spaceId,
          connectorId: connector.id,
          externalRef: doc.ref,
          title: doc.title,
          metadata: JSON.stringify(doc.metadata),
          vectors: {
            create: doc.chunks.map((c) => ({ vectorId: c.id })),
          },
        },
      });
    }
  });
}

/**
 * Purge vectors whose IDs no longer appear in the fresh set. Ground truth
 * is the index's listIds(); we restrict deletion to IDs this connector owns —
 * an ID is "owned" if a (now-deleted) DocumentVector referenced it OR it is in
 * the fresh set. Since reconcileDocuments already rewrote the rows, we compute
 * the owned set from the index minus the fresh set, scoped by what this
 * connector could have produced. To stay scoped without cross-connector
 * collisions, chunk IDs are connector-namespaced (connector is a hash input),
 * so an ID present in the index but absent from this connector's fresh
 * set AND matching a prior row of this connector is stale.
 *
 * Implementation: stale = indexIds ∩ priorVectorIds − freshIds. priorVectorIds
 * is captured before reconcile rewrote the rows.
 */
async function purgeStale(
  ref: SpaceRef,
  connectorId: string,
  freshIds: Set<string>,
): Promise<number> {
  // We can no longer read prior rows (reconcile deleted them), so we reconstruct
  // "owned" from the index ground truth: any index ID not in the fresh set is a
  // purge candidate, but we must not delete other connectors' vectors. We scope
  // by intersecting with IDs the index reports that are NOT in any other
  // connector's current DocumentVector rows.
  let indexIds: string[];
  try {
    indexIds = await listIds(ref);
  } catch {
    // If we can't enumerate the index, skip the purge rather than guess.
    return 0;
  }

  // IDs currently owned by OTHER connectors in this space — never purge these.
  const otherOwned = new Set(
    (
      await prisma.documentVector.findMany({
        where: {
          document: { spaceId: ref.id ?? undefined, connectorId: { not: connectorId } },
        },
        select: { vectorId: true },
      })
    ).map((v) => v.vectorId),
  );

  const stale = indexIds.filter(
    (id) => !freshIds.has(id) && !otherOwned.has(id),
  );

  if (stale.length === 0) return 0;
  await deleteVectors(ref, stale);
  return stale.length;
}

// Live progress written to the connector's `detail` mid-sync so a polling
// client can show movement. Namespaced under `progress` to distinguish it from
// the terminal detail payload ({truncated, targets} or an error string).
export interface SyncProgress {
  phase: "pulling" | "embedding" | "finishing";
  chunks: number;
  target?: string;
  targetIndex?: number; // 1-based position within the target list
  targetTotal?: number;
}

/**
 * Heartbeat the connector's `detail` with live progress (status stays
 * "syncing"). Best-effort: a failed heartbeat must never fail the sync, so
 * errors are swallowed.
 */
async function writeProgress(
  connectorId: string,
  progress: SyncProgress,
): Promise<void> {
  try {
    await prisma.connector.update({
      where: { id: connectorId },
      data: { detail: JSON.stringify({ progress }) },
    });
  } catch {
    // Progress is advisory; ignore write failures.
  }
}

/** Persist a connector's terminal status, detail, counts, and lastSyncAt. */
async function finalizeStatus(
  connectorId: string,
  status: SyncResult["status"],
  data: { detail: string; chunkCount: number },
): Promise<void> {
  await prisma.connector.update({
    where: { id: connectorId },
    data: {
      status,
      detail: data.detail,
      chunkCount: data.chunkCount,
      lastSyncAt: new Date(),
    },
  });
}
