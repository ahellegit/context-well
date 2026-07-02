// Connector plugin contract. A connector is a self-contained adapter for an
// external source (GitHub, Slack, …): it validates its credentials, lists the
// targets a user can select (repos, channels), and streams normalized Chunks for
// the selected targets. The sync orchestrator (sync.ts) consumes this contract;
// the registry (registry.ts) maps a `kind` string to an implementation so the UI
// can discover the installed connectors.
//
// The shared interface is validate / list targets / sync → chunks + metadata,
// with stable chunk IDs and per-source-type chunking — the connector decides
// grouping and calls the chunk.ts helpers.

/**
 * A normalized unit of content ready to upsert into CyborgDB. `contents` is the
 * text the service embeds server-side (text-in mode); `id` is the stable hash
 * so resync is idempotent and purgeable.
 *
 * `metadata` carries the source-card fields. `snippet` (the chunk text, for
 * display without a second fetch), `title`, and `connector` are mandatory; a
 * connector adds its own fields (repo/path/permalink, channel/author/ts, …).
 */
export interface Chunk {
  id: string;
  contents: string;
  metadata: Record<string, unknown> & {
    snippet: string;
    title: string;
    connector: string;
  };
}

/**
 * A selectable ingestion target a connector exposes (a repo, a channel). `id` is
 * the stable handle the orchestrator passes back to `sync`; `label` is shown in
 * the UI; `note` flags a caveat (e.g. "bot not a member — cannot read").
 */
export interface ConnectorTarget {
  id: string;
  label: string;
  note?: string;
}

/**
 * The result of validating a connector's credentials. `ok` gates target
 * selection; `message` carries a human reason on failure; `scopeWarning` flags
 * excess scope on success (least-privilege advisory, not a hard failure).
 */
export interface ValidationResult {
  ok: boolean;
  message?: string;
  scopeWarning?: string;
}

/**
 * The connector plugin interface. Implementations are stateless with respect to
 * a sync: they receive credentials per call so the same instance serves every
 * space. `sync` is an async iterable so the orchestrator can stream/batch large
 * corpora without buffering the whole source in memory.
 */
export interface Connector {
  /** Stable kind key, e.g. "github" | "slack". Used as the registry key. */
  kind: string;

  /** Check credentials are present and have the minimum required scope. */
  validate(creds: unknown): Promise<ValidationResult>;

  /** List the targets these credentials can ingest (repos, channels). */
  listTargets(creds: unknown): Promise<ConnectorTarget[]>;

  /** Stream normalized chunks for the selected targets. */
  sync(creds: unknown, targetIds: string[]): AsyncIterable<Chunk>;
}
