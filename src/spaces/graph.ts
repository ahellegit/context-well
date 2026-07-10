// SPIKE: on-the-fly similarity-graph builder for a space.
//
// Context Well stores chunks as flat vectors in CyborgDB — there are no
// explicit edges. This synthesizes a *similarity graph*: every chunk is a node,
// and an edge joins two chunks whose embeddings sit within a cosine threshold.
// It reuses the space's existing cosine index — no new database, no LLM, no
// ingest changes. Intended as a read-only "map of this space" exploration view.
//
// Cost note: kNN here has no batch form, so building the graph runs one text
// query per node. Node count is therefore capped and any truncation is reported
// in `meta` (never silently dropped).

import type { Space } from "@prisma/client";
import type { QueryResultItem } from "cyborgdb";
import { config } from "../config.js";
import { openIndex } from "../cyborg/index-service.js";
import { prisma } from "../db/client.js";

export interface GraphNode {
  id: string;
  label: string;
  connector: string; // github | slack | upload | … → drives node color
  snippet: string;
  chunks?: number; // document nodes: how many chunks the document holds
}

export interface GraphEdge {
  source: string;
  target: string;
  weight: number; // cosine similarity, 0..1
}

export interface SpaceGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  meta: {
    total: number; // vectors (chunk graph) or documents (doc graph) present
    rendered: number; // nodes actually in the graph
    truncated: boolean; // total > rendered (node cap was hit)
    k: number;
    threshold: number;
    cached?: boolean; // doc graph: served from the server cache (not rebuilt)
  };
}

export interface GraphOptions {
  maxNodes?: number; // cap on nodes (default 150, hard max 400)
  neighbors?: number; // k nearest neighbours per node (default 6)
  threshold?: number; // minimum similarity for an edge (default 0.55)
}

// Batch-fetch contents + metadata straight from the cyborgdb-service REST API.
// We bypass the SDK's get() for the same reason chat retrieval does: in text-in
// mode it base64-mangles plaintext contents (see cyborg/index-service.ts).
// Best-effort — an empty map just yields sparser labels, never a hard failure.
async function fetchNodeData(
  space: { slug: string; indexKey: string },
  ids: string[],
): Promise<Map<string, { contents: string; metadata: Record<string, unknown> }>> {
  const byId = new Map<
    string,
    { contents: string; metadata: Record<string, unknown> }
  >();
  if (ids.length === 0) return byId;
  try {
    const res = await fetch(`${config.cyborgdbUrl}/v1/vectors/get`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        index_name: space.slug,
        index_key: space.indexKey, // hex, as stored on Space.indexKey
        ids,
        include: ["contents", "metadata"],
      }),
    });
    if (!res.ok) return byId;
    const data = (await res.json()) as {
      results?: { id: string; contents?: unknown; metadata?: unknown }[];
    };
    for (const item of data.results ?? []) {
      byId.set(item.id, {
        contents: typeof item.contents === "string" ? item.contents : "",
        metadata: (item.metadata ?? {}) as Record<string, unknown>,
      });
    }
  } catch {
    // Leave the map empty; labels fall back to the id.
  }
  return byId;
}

function truncate(s: string, n: number): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function labelFrom(meta: Record<string, unknown>, snippet: string): string {
  const title = typeof meta.title === "string" ? meta.title.trim() : "";
  if (title) return truncate(title, 48);
  const s = truncate(snippet, 48);
  return s || "untitled";
}

/**
 * Build a similarity graph for a space by reusing its cosine index.
 * Throws {@link IndexLockedError} (from openIndex) when the index can't be
 * opened — the caller maps that to a 423.
 */
export async function buildSpaceGraph(
  space: Space,
  opts: GraphOptions = {},
): Promise<SpaceGraph> {
  const maxNodes = Math.min(Math.max(Math.trunc(opts.maxNodes ?? 150), 1), 400);
  const k = Math.min(Math.max(Math.trunc(opts.neighbors ?? 6), 1), 20);
  const threshold = Math.min(Math.max(opts.threshold ?? 0.55, 0), 1);

  const index = await openIndex(space); // throws IndexLockedError if locked
  const allIds = (await index.listIds()).ids;
  const total = allIds.length;
  const ids = allIds.slice(0, maxNodes);

  const data = await fetchNodeData(space, ids);

  const nodes: GraphNode[] = ids.map((id) => {
    const meta = data.get(id)?.metadata ?? {};
    const snippet =
      (typeof meta.snippet === "string" && meta.snippet) ||
      data.get(id)?.contents ||
      "";
    return {
      id,
      label: labelFrom(meta, snippet),
      connector: typeof meta.connector === "string" ? meta.connector : "unknown",
      snippet: truncate(snippet, 200),
    };
  });

  const present = new Set(ids);
  const seen = new Set<string>();
  const edges: GraphEdge[] = [];

  for (const node of nodes) {
    const text = data.get(node.id)?.contents || node.snippet;
    if (!text) continue;
    const resp = await index.query({
      queryContents: text,
      topK: k + 1, // +1 to absorb the node's own self-hit
      include: ["distance"],
    });
    const items = (resp.results ?? []) as unknown as QueryResultItem[];
    for (const item of items) {
      if (item.id === node.id || !present.has(item.id)) continue;
      const sim = 1 - (item.distance ?? 1);
      if (sim < threshold) continue;
      // Undirected: dedupe on the sorted id pair, keeping the first (max) weight.
      const pair =
        node.id < item.id ? `${node.id}|${item.id}` : `${item.id}|${node.id}`;
      if (seen.has(pair)) continue;
      seen.add(pair);
      edges.push({
        source: node.id,
        target: item.id,
        weight: Number(sim.toFixed(3)),
      });
    }
  }

  return {
    nodes,
    edges,
    meta: {
      total,
      rendered: nodes.length,
      truncated: total > nodes.length,
      k,
      threshold,
    },
  };
}

// --- document-graph cache --------------------------------------------------
// Building a doc graph runs one query per representative chunk, so we cache the
// result per space in-process and reuse it until the document set changes. The
// cache key includes a signature over (documentId, chunkCount) pairs, so any
// ingest/resync/delete naturally invalidates it — no explicit hooks needed.
interface DocGraphCacheEntry {
  sig: string;
  graph: SpaceGraph;
}
const docGraphCache = new Map<string, DocGraphCacheEntry>();

async function docSetSignature(spaceId: string): Promise<string> {
  const docs = await prisma.document.findMany({
    where: { spaceId },
    select: { id: true, _count: { select: { vectors: true } } },
  });
  docs.sort((a, b) => a.id.localeCompare(b.id));
  return `${docs.length}|${docs.map((d) => `${d.id}:${d._count.vectors}`).join(",")}`;
}

/**
 * Document graph with a per-space cache. Returns the cached graph when the
 * document set (and the requested options) are unchanged, otherwise rebuilds
 * and stores it. Pass `refresh` to force a rebuild (the "Rebuild" button).
 */
export async function getDocGraph(
  space: Space,
  opts: DocGraphOptions = {},
  refresh = false,
): Promise<SpaceGraph> {
  const optSig = JSON.stringify({
    maxDocs: opts.maxDocs ?? null,
    samplesPerDoc: opts.samplesPerDoc ?? null,
    neighbors: opts.neighbors ?? null,
    threshold: opts.threshold ?? null,
  });
  const sig = `${await docSetSignature(space.id)}#${optSig}`;

  if (!refresh) {
    const hit = docGraphCache.get(space.id);
    if (hit && hit.sig === sig) {
      return { ...hit.graph, meta: { ...hit.graph.meta, cached: true } };
    }
  }

  const graph = await buildDocGraph(space, opts);
  const stored: SpaceGraph = { ...graph, meta: { ...graph.meta, cached: false } };
  docGraphCache.set(space.id, { sig, graph: stored });
  return stored;
}

export interface DocGraphOptions {
  maxDocs?: number; // cap on document nodes (default 100, hard max 400)
  samplesPerDoc?: number; // representative chunks queried per doc (default 3, max 8)
  neighbors?: number; // topK chunk hits per query (default 12, max 30)
  threshold?: number; // minimum doc-to-doc similarity for an edge (default 0.5)
}

/**
 * Build a *document-level* similarity graph: one node per ingested document,
 * with an edge between two documents when their chunks are semantically close.
 *
 * CyborgDB only holds chunk vectors, so document similarity is aggregated up:
 * for each document we query the index with a few of its representative chunks,
 * map the neighbour chunks back to their parent documents (via DocumentVector),
 * and keep the strongest chunk-pair similarity as the document-pair weight.
 *
 * This is the curation lens for the Sources view — "what overlaps, what's
 * redundant, what's orphaned." Coarser and more actionable than the chunk graph.
 */
export async function buildDocGraph(
  space: Space,
  opts: DocGraphOptions = {},
): Promise<SpaceGraph> {
  const maxDocs = Math.min(Math.max(Math.trunc(opts.maxDocs ?? 100), 1), 400);
  const samplesPerDoc = Math.min(Math.max(Math.trunc(opts.samplesPerDoc ?? 3), 1), 8);
  const k = Math.min(Math.max(Math.trunc(opts.neighbors ?? 12), 1), 30);
  const threshold = Math.min(Math.max(opts.threshold ?? 0.5, 0), 1);

  const index = await openIndex(space); // throws IndexLockedError if locked

  const allDocs = await prisma.document.findMany({
    where: { spaceId: space.id },
    include: {
      connector: { select: { kind: true } },
      vectors: { select: { vectorId: true } },
    },
  });
  const total = allDocs.length;

  // Bias the cap toward the largest documents — they anchor the map's structure.
  allDocs.sort((a, b) => b.vectors.length - a.vectors.length);
  const docs = allDocs.slice(0, maxDocs);

  // vectorId → owning documentId, restricted to the rendered set so neighbour
  // chunks from truncated documents are simply ignored.
  const vecToDoc = new Map<string, string>();
  for (const d of docs) {
    for (const v of d.vectors) vecToDoc.set(v.vectorId, d.id);
  }

  const nodes: GraphNode[] = docs.map((d) => ({
    id: d.id,
    label: truncate(d.title || d.externalRef, 56),
    connector: d.connector?.kind ?? "unknown",
    snippet: truncate(d.externalRef || d.title, 200),
    chunks: d.vectors.length,
  }));

  // Representative chunk ids to query with (first N per doc), tagged by owner.
  const samples: { docId: string; vectorId: string }[] = [];
  for (const d of docs) {
    for (const v of d.vectors.slice(0, samplesPerDoc)) {
      samples.push({ docId: d.id, vectorId: v.vectorId });
    }
  }

  const contents = await fetchNodeData(space, samples.map((s) => s.vectorId));

  // Accumulate the strongest similarity seen for each undirected document pair.
  const pairMax = new Map<string, number>();
  for (const s of samples) {
    const text = contents.get(s.vectorId)?.contents;
    if (!text) continue;
    const resp = await index.query({
      queryContents: text,
      topK: k,
      include: ["distance"],
    });
    const items = (resp.results ?? []) as unknown as QueryResultItem[];
    for (const item of items) {
      const otherDoc = vecToDoc.get(item.id);
      if (!otherDoc || otherDoc === s.docId) continue; // self-doc or out-of-set
      const sim = 1 - (item.distance ?? 1);
      if (sim < threshold) continue;
      const pair = s.docId < otherDoc ? `${s.docId}|${otherDoc}` : `${otherDoc}|${s.docId}`;
      const prev = pairMax.get(pair);
      if (prev === undefined || sim > prev) pairMax.set(pair, sim);
    }
  }

  const edges: GraphEdge[] = [];
  for (const [pair, weight] of pairMax) {
    const [source, target] = pair.split("|");
    edges.push({ source, target, weight: Number(weight.toFixed(3)) });
  }

  return {
    nodes,
    edges,
    meta: {
      total,
      rendered: nodes.length,
      truncated: total > nodes.length,
      k,
      threshold,
    },
  };
}
