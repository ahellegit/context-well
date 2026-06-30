// Per-space CyborgDB index lifecycle and data operations (U4).
//
// Requirements: R7, R8, R9, R10, R23, KTD3, KTD3a, KTD4, KTD7.
//
// The app runs CyborgDB in "text-in" mode (KTD3): it never computes
// embeddings itself. Upserts send `contents` (the chunk text) and let the
// service embed server-side with the index's `embeddingModel`; queries send
// `queryContents` and pass `include: ["distance", "metadata"]` so results
// carry a distance and the stored metadata (KTD3a). Indexes are created with
// `metric: "cosine"` (the SDK sets no default) and the embedding model from
// the Space row (default all-MiniLM-L6-v2 → 384d).
//
// NOTE on the dimension guard: the cyborgdb SDK (0.17.0) exposes the index
// dimension via `getDimension(): Promise<number>` (KTD3 drift guard).

import type { EncryptedIndex, QueryResultItem } from "cyborgdb";
import { cyborgClient, hexToKey, keyToHex } from "./client.js";
import { prisma } from "../db/client.js";

// The embedding model is a global constant in v1 (KTD3); Space.embeddingModel
// stores it per row but is always this value. all-MiniLM-L6-v2 → 384 dims.
export const DEFAULT_EMBEDDING_MODEL = "all-MiniLM-L6-v2";
export const EXPECTED_DIMENSION = 384;

// The subset of the Space row this service needs. Accepting a structural type
// (rather than the full Prisma model) keeps callers and tests light.
export interface SpaceRef {
  id?: string;
  slug: string;
  indexKey: string; // hex; empty string when not yet provisioned
  embeddingModel?: string | null;
}

// A chunk ready to upsert. `contents` is the text the service embeds (KTD3);
// `id` is the stable hash from KTD7. `metadata.snippet` holds the chunk text
// for source-card display so query results need no second get() (KTD3a).
export interface CyborgChunk {
  id: string;
  contents: string;
  metadata: Record<string, unknown> & { snippet: string };
}

// A normalized retrieval hit. `distance` is the raw cosine distance (smaller =
// more similar); `similarity` is the derived 1 - distance score the threshold
// and UI use (KTD3a / KTD8b).
export interface CyborgHit {
  id: string;
  distance: number;
  similarity: number;
  metadata: Record<string, unknown>;
  // Full chunk text, fetched via get() after the query (query() itself returns
  // only id/distance/metadata — never contents). Undefined if the fetch failed;
  // callers fall back to metadata.snippet for display.
  contents?: string;
}

/**
 * Thrown when an index exists but cannot be opened with the supplied key —
 * a present-but-wrong or corrupted key (KTD4 / R8: "index locked"). Distinct
 * from generic service/network errors so the caller can surface the brick
 * state rather than a transient failure.
 */
export class IndexLockedError extends Error {
  readonly cause?: unknown;
  constructor(slug: string, cause?: unknown) {
    super(
      `Index for space "${slug}" is locked: the stored key did not unlock it ` +
        `(wrong or corrupted key). The space's data is unreadable until the ` +
        `correct key is restored.`,
    );
    this.name = "IndexLockedError";
    this.cause = cause;
  }
}

function embeddingModelFor(space: SpaceRef): string {
  return space.embeddingModel || DEFAULT_EMBEDDING_MODEL;
}

// CyborgDB key/auth failures on describe/load surface through the SDK's
// handleApiError as messages like "401 - ..." / "403 - ..." or text mentioning
// decryption. A 32-byte length check alone won't catch a wrong-but-valid-length
// key, so we classify on the service error (KTD4).
function looksLikeKeyFailure(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();
  return (
    lower.includes("401") ||
    lower.includes("403") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden") ||
    lower.includes("decrypt") ||
    lower.includes("invalid key") ||
    lower.includes("key") && lower.includes("incorrect")
  );
}

/**
 * Ensure a space has a provisioned index. If the space has no key yet, mint a
 * 32-byte key, persist it as hex on the Space row, and create the index with
 * cosine metric + the space's embedding model. Idempotent: a pre-existing
 * index ("already exists") is treated as success.
 *
 * Persists the key via Prisma when `space.id` is set; otherwise the caller is
 * responsible for persistence (the generated hex is returned).
 *
 * @returns the hex-encoded key for the space's index.
 */
export async function provisionIndex(space: SpaceRef): Promise<string> {
  // Reuse an existing persisted key — never mint a second one for a space
  // (that would orphan the data encrypted under the first key).
  const keyHex = space.indexKey && space.indexKey.length > 0
    ? space.indexKey
    : keyToHex(cyborgClient.generateKey());

  const isNewKey = keyHex !== space.indexKey;

  if (isNewKey && space.id) {
    await prisma.space.update({
      where: { id: space.id },
      data: { indexKey: keyHex },
    });
  }

  try {
    await cyborgClient.createIndex({
      indexName: space.slug,
      indexKey: hexToKey(keyHex),
      metric: "cosine",
      embeddingModel: embeddingModelFor(space),
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    // The index already exists — provisioning is idempotent.
    if (/already exist/i.test(msg)) {
      return keyHex;
    }
    throw error;
  }

  return keyHex;
}

/**
 * Open (load) a space's existing index for data operations. Decodes the hex
 * key, loads the index, and asserts the dimension matches the expected 384 to
 * catch embedding-model/dimension drift (KTD3). A failure attributable to a
 * wrong/missing key is reclassified as {@link IndexLockedError} (R8).
 */
export async function openIndex(space: SpaceRef): Promise<EncryptedIndex> {
  if (!space.indexKey || space.indexKey.length === 0) {
    throw new IndexLockedError(space.slug);
  }

  const key = hexToKey(space.indexKey);

  let index: EncryptedIndex;
  try {
    index = await cyborgClient.loadIndex({
      indexName: space.slug,
      indexKey: key,
    });
  } catch (error: unknown) {
    if (looksLikeKeyFailure(error)) {
      throw new IndexLockedError(space.slug, error);
    }
    throw error;
  }

  // Dimension drift guard (KTD3): a model swap would corrupt retrieval.
  // getDimension() is backed by describe(), so a wrong key can also surface
  // here as an auth error — reclassify it as an index-locked condition.
  let dimension: number | null | undefined;
  try {
    dimension = await index.getDimension();
  } catch (error: unknown) {
    if (looksLikeKeyFailure(error)) {
      throw new IndexLockedError(space.slug, error);
    }
    throw error;
  }

  if (dimension !== EXPECTED_DIMENSION) {
    throw new Error(
      `Index for space "${space.slug}" has dimension ${dimension}, expected ` +
        `${EXPECTED_DIMENSION} (embedding-model drift). Re-provision the index.`,
    );
  }

  return index;
}

/**
 * Upsert chunks into a space's index. Sends `contents` (text) + metadata +
 * stable IDs (KTD7) — never a precomputed vector. The service embeds the
 * contents server-side (KTD3 / AE2).
 */
export async function upsertChunks(
  space: SpaceRef,
  chunks: CyborgChunk[],
): Promise<void> {
  if (chunks.length === 0) return;
  const index = await openIndex(space);
  await index.upsert({
    items: chunks.map((c) => ({
      id: c.id,
      contents: c.contents,
      metadata: c.metadata,
    })),
  });
}

/**
 * Run a text query against a space's index. Passes `queryContents` (not a
 * bare id or vector) and `include: ["distance", "metadata"]` (KTD3a), then
 * normalizes hits: similarity = 1 - distance.
 */
export async function query(
  space: SpaceRef,
  text: string,
  topK: number,
): Promise<CyborgHit[]> {
  const index = await openIndex(space);
  const response = await index.query({
    queryContents: text,
    topK,
    include: ["distance", "metadata"],
  });

  // For a single text query the SDK flattens `results` to QueryResultItem[].
  const items = (response.results ?? []) as unknown as QueryResultItem[];

  const hits: CyborgHit[] = items.map((item) => {
    const distance = item.distance ?? 1;
    return {
      id: item.id,
      distance,
      similarity: 1 - distance,
      metadata: (item.metadata ?? {}) as Record<string, unknown>,
    };
  });

  // query() returns no contents — only id/distance/metadata. Fetch the full
  // chunk text for the hits via get() so the LLM sees the whole chunk, not just
  // the 200-char display snippet stored in metadata. Best-effort: on failure we
  // leave contents undefined and callers fall back to the snippet.
  if (hits.length > 0) {
    try {
      const got = await index.get({
        ids: hits.map((h) => h.id),
        include: ["contents"],
      });
      const byId = new Map<string, string>();
      for (const g of got) {
        if (g.contents != null) byId.set(g.id, contentsToString(g.contents));
      }
      for (const h of hits) {
        const c = byId.get(h.id);
        if (c) h.contents = c;
      }
    } catch {
      // Leave contents undefined; renderSource falls back to metadata.snippet.
    }
  }

  return hits;
}

/** Coerce a get() contents value (Buffer | Blob | string) to a string. */
function contentsToString(c: Buffer | Blob | string): string {
  if (typeof c === "string") return c;
  if (Buffer.isBuffer(c)) return c.toString("utf-8");
  // A Blob (or anything else) — best-effort string coercion; the service
  // returns string/Buffer in practice, so this branch is a defensive fallback.
  return String(c);
}

/**
 * Delete vectors by id from a space's index (resync purge — R23 / KTD7).
 */
export async function deleteVectors(
  space: SpaceRef,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  const index = await openIndex(space);
  await index.delete({ ids });
}

/**
 * List all vector IDs in a space's index (resync reconciliation — U7).
 */
export async function listIds(space: SpaceRef): Promise<string[]> {
  const index = await openIndex(space);
  const result = await index.listIds();
  return result.ids;
}

/**
 * Train a space's index, crossing from exhaustive to ANN search. Triggered
 * post-sync once the vector count passes a threshold.
 */
export async function train(space: SpaceRef): Promise<void> {
  const index = await openIndex(space);
  await index.train();
}

/**
 * Tear down a space's index entirely (space deletion — U6).
 */
export async function deleteIndex(space: SpaceRef): Promise<void> {
  const index = await openIndex(space);
  await index.deleteIndex();
}
