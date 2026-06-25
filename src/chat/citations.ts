// Citation validation + source-card snapshot (U10).
//
// Requirements: R17 (inline `[n]` citations map to numbered source cards), R30
// (persist a full snapshot of the cited source cards — id, title, snippet,
// score, connector — so a reopened thread renders citations even after a later
// sync purged the underlying vectors).
//
// The model emits `[n]` references in its answer. We parse them, drop any n
// outside 1..hits.length (a "dangling" citation the model hallucinated), and
// return the cited subset plus a stable card snapshot. Score is the hit's
// derived similarity (1 - distance), rounded for display.

import type { CyborgHit } from "../cyborg/index-service.js";

// A persisted source card (R30 snapshot). Stored as JSON on the Message row.
export interface SourceCard {
  id: string;
  title: string;
  snippet: string;
  // Derived similarity (1 - distance), rounded to 2 decimals for display.
  score: number;
  connector: string;
}

export interface CitationResult {
  // Distinct 1-based citation numbers the model emitted that resolve to a hit,
  // in ascending order.
  citedNumbers: number[];
  // The card snapshot for exactly the cited hits, in citation-number order
  // (R30). This is what gets persisted on the assistant message.
  citedCards: SourceCard[];
  // Citation numbers the model emitted that fall outside 1..hits.length and
  // were dropped (diagnostics / R17 "flagged").
  droppedNumbers: number[];
}

// Round a 0–1 similarity to 2 decimals for display/storage (R30).
function roundScore(similarity: number): number {
  return Math.round(similarity * 100) / 100;
}

/** Build the full source card for a hit (used for both the rail and snapshots). */
export function toSourceCard(hit: CyborgHit): SourceCard {
  const md = hit.metadata as Record<string, unknown>;
  return {
    id: hit.id,
    title: typeof md.title === "string" ? md.title : "",
    snippet: typeof md.snippet === "string" ? md.snippet : "",
    score: roundScore(hit.similarity),
    connector: typeof md.connector === "string" ? md.connector : "",
  };
}

/**
 * Parse `[n]` references from an answer, validate them against the retrieved
 * hits, and build the cited source-card snapshot (R17, R30).
 *
 * - Only bracketed integers like `[1]`, `[12]` are recognized; markdown link
 *   refs `[text]` (non-numeric) are ignored.
 * - A citation n is valid iff 1 <= n <= hits.length. Out-of-range numbers
 *   (e.g. `[7]` with 3 hits) are dropped and reported in `droppedNumbers`.
 * - Cards are returned in ascending citation-number order, deduped.
 */
export function validateCitations(
  answerText: string,
  hits: CyborgHit[],
): CitationResult {
  const matches = answerText.matchAll(/\[(\d+)\]/g);
  const seenCited = new Set<number>();
  const seenDropped = new Set<number>();

  for (const m of matches) {
    const n = Number.parseInt(m[1], 10);
    if (Number.isNaN(n)) continue;
    if (n >= 1 && n <= hits.length) {
      seenCited.add(n);
    } else {
      seenDropped.add(n);
    }
  }

  const citedNumbers = [...seenCited].sort((a, b) => a - b);
  const droppedNumbers = [...seenDropped].sort((a, b) => a - b);

  const citedCards = citedNumbers.map((n) => toSourceCard(hits[n - 1]));

  return { citedNumbers, citedCards, droppedNumbers };
}
