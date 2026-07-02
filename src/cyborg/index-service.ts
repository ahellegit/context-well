// Per-space CyborgDB index lifecycle and data operations.
//
// The app runs CyborgDB in "text-in" mode: it never computes
// embeddings itself. Upserts send `contents` (the chunk text) and let the
// service embed server-side with the index's `embeddingModel`; queries send
// `queryContents` and pass `include: ["distance", "metadata"]` so results
// carry a distance and the stored metadata. Indexes are created with
// `metric: "cosine"` (the SDK sets no default) and the embedding model from
// the Space row (default all-MiniLM-L6-v2 → 384d).
//
// NOTE on the dimension guard: the cyborgdb SDK (0.17.0) exposes the index
// dimension via `getDimension(): Promise<number>`.

import type { EncryptedIndex, QueryResultItem } from "cyborgdb";
import { cyborgClient, hexToKey, keyToHex } from "./client.js";
import { prisma } from "../db/client.js";
import { config } from "../config.js";

// The embedding model is a global constant in v1; Space.embeddingModel
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

// A chunk ready to upsert. `contents` is the text the service embeds;
// `id` is the stable content hash. `metadata.snippet` holds the chunk text
// for source-card display so query results need no second get().
export interface CyborgChunk {
  id: string;
  contents: string;
  metadata: Record<string, unknown> & { snippet: string };
}

// A normalized retrieval hit. `distance` is the raw cosine distance (smaller =
// more similar); `similarity` is the derived 1 - distance score the threshold
// and UI use.
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
 * a present-but-wrong or corrupted key ("index locked"). Distinct
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
// key, so we classify on the service error.
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
 * catch embedding-model/dimension drift. A failure attributable to a
 * wrong/missing key is reclassified as {@link IndexLockedError}.
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

  // Dimension drift guard: a model swap would corrupt retrieval.
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
 * stable IDs — never a precomputed vector. The service embeds the
 * contents server-side.
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
 * bare id or vector) and `include: ["distance", "metadata"]`, then
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
  // chunk text for the hits so the LLM sees the whole chunk, not just the
  // 200-char display snippet stored in metadata.
  if (hits.length > 0) {
    const byId = await fetchContents(space, hits.map((h) => h.id));
    for (const h of hits) {
      const c = byId.get(h.id);
      if (c) h.contents = c;
    }
  }

  return hits;
}

/**
 * Fetch decrypted chunk contents for the given ids straight from the
 * cyborgdb-service REST API (`POST /v1/vectors/get`), returning an id→text map.
 *
 * We deliberately bypass the SDK's `index.get()`: in text-in mode chunk
 * `contents` are stored as plain UTF-8 strings (the service embeds them), but
 * the SDK's get() unconditionally base64-decodes the returned contents — which
 * turns plain-text strings into mojibake (only the binary-upsert path stores
 * base64). The REST endpoint returns the stored plaintext intact. Best-effort:
 * returns an empty map on any failure, so callers fall back to metadata.snippet.
 */
async function fetchContents(
  space: SpaceRef,
  ids: string[],
): Promise<Map<string, string>> {
  const byId = new Map<string, string>();
  if (ids.length === 0 || !space.indexKey) return byId;
  try {
    const res = await fetch(`${config.cyborgdbUrl}/v1/vectors/get`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        index_name: space.slug,
        index_key: space.indexKey, // hex, as stored on Space.indexKey
        ids,
        include: ["contents"],
      }),
    });
    if (!res.ok) return byId;
    const data = (await res.json()) as {
      results?: { id: string; contents?: unknown }[];
    };
    for (const item of data.results ?? []) {
      if (typeof item.contents === "string" && item.contents.length > 0) {
        byId.set(item.id, item.contents);
      }
    }
  } catch {
    // Network/parse failure — leave the map empty; callers fall back to snippet.
  }
  return byId;
}

/**
 * Delete vectors by id from a space's index (resync purge).
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
 * List all vector IDs in a space's index (resync reconciliation).
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
 * Tear down a space's index entirely (space deletion).
 */
export async function deleteIndex(space: SpaceRef): Promise<void> {
  const index = await openIndex(space);
  await index.deleteIndex();
}
