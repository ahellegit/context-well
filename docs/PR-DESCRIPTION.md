# feat: Context Well — self-hosted RAG chat on CyborgDB + Ollama (v1)

## Summary
v1 of Context Well, a self-hosted vector-grounded LLM chat workspace. A Node/TypeScript + Fastify backend serves the (rewired) HTML prototype, persists app metadata in Prisma/SQLite, stores per-space corpora in CyborgDB (server-side embedding), and streams chat completions from a user-provided Ollama. GitHub and Slack connectors ingest content through a shared plugin interface.

- Origin: `docs/brainstorms/2026-06-25-knowledgellm-rag-cyborgdb-requirements.md`
- Plan: `docs/plans/2026-06-25-001-feat-knowledgellm-rag-cyborgdb-plan.md`

## Key decisions
- **CyborgDB embeds text server-side** — Ollama is chat-only (no embed-model picker). `cyborgdb-js` with `metric:"cosine"` + `include:["distance","metadata"]`; query returns `distance`, similarity = `1 - distance`. SDK-managed 32-byte index keys per space.
- **Node/TS + Fastify**, serving the prototype; Prisma + SQLite (slug = CyborgDB index name; `document_vectors` join table for deletion/resync correctness).
- **Multi-user login, no RBAC** (gated registration, rate-limited login, rotating sessions).
- **Connector plugin interface** — GitHub (repo files + issues), Slack (channels msgs + threads), per-space tokens, manual sync, per-space sync lock, idempotent resync with stale-vector purge scoped to completed targets.
- **Streaming chat (SSE)** — prompt-injection delimiting, context-window budgeting, citation validation, R30 source snapshots; distinct no-sources (R18) vs retrieval-error (R25) states; cancel support.
- **docker-compose** bundles app + `cyborgdb-service` (disk mode); Ollama external. Secrets via `.env` for v1 (at-rest encryption deferred).
- Adds `@langchain/core` as an explicit dependency (undeclared runtime dep of the `cyborgdb` package).

## Testing
- **106 vitest tests passing** across auth, cyborg wrapper, ollama, settings, spaces, connectors (github/slack/sync), chat. `tsc` clean.
- Frontend setup flow browser-verified (zero console errors).
- ⚠️ Full E2E (space provisioning, real ingestion, live streaming, citation linking) needs a running `cyborgdb-service` + Ollama — **manual smoke-test required before deploy** (see below).

## Implementation
Built across 13 units: U1 scaffold/docker-compose, U2 Prisma schema, U3 auth, U4 CyborgDB wrapper, U5 Ollama+settings, U6 spaces, U7 connector framework+sync, U8 GitHub, U9 Slack, U10 chat orchestration, U11–U13 frontend rewiring. A Tier-2 code review (8 personas) ran; all P0/P1 findings fixed (sync purge data-loss scoping, broken `{{user.name}}` substitution, connector fetch timeouts, SSRF redirect+encoding hardening, `indexKey` API leak, source-delimiter escaping, Retry-After cap, stuck-`syncing` status).

## Known Residuals (accepted P2/P3 — not blocking)
- **P2** GitHub `tree.truncated` not checked → silent partial ingest with `connected` status (`src/connectors/github.ts`).
- **P2** Connector delete + space delete don't take the per-space sync lock → race with in-flight sync's reconcile/purge (`src/connectors/routes.ts`, `src/spaces/service.ts`).
- **P2** Sync runs inline on the HTTP request thread; no request timeout / client-disconnect abort (`src/connectors/routes.ts`).
- **P2** In-memory sync lock is process-local → no coordination under multi-process deployment (`src/connectors/sync.ts`).
- **P2** Citations validated against the full usable hit set, not the context-budget-trimmed subset actually sent to the model (`src/chat/orchestrator.ts`).
- **P2** `getSettings()` empty (unconfigured) → opaque error instead of a typed not-configured response (`src/chat/orchestrator.ts`).
- **P2** Maintainability: duplicated `SpaceRef` projection (×3), `sleep()` (×2), `isConfigured` double-read.
- **P3** SSE backpressure: `reply.raw.write()` return value ignored (`src/chat/routes.ts`).
- **Testing gaps**: route-level (HTTP-boundary) tests missing for spaces/settings/chat-SSE/connector-delete (service layers are covered).

## Post-Deploy Monitoring & Validation
Self-hosted single-stack app. After `docker-compose up`:
- **Validate:** `GET /api/health` → 200; then register → setup Ollama → create a space → add a connector → "sync now" → one chat turn. A successful round-trip proves CyborgDB server-side embedding + Ollama reachability.
- **Watch (app logs):** CyborgDB connection errors; `IndexLockedError` (key/index issues); Ollama unreachable/timeout.
- **Healthy signals:** connector status reaches `connected`/`partial` with chunk counts; chat SSE emits `sources` + `token` + `done`.
- **Failure signals:** repeated `retrieval-error` SSE events (CyborgDB down); connector stuck `syncing` (mitigated this PR); "no models" at setup (Ollama empty — run `ollama pull`).
- **Rollback:** `docker-compose down`; vectors persist in the `cyborgdb_data` volume and app data volume. Re-deploy prior image.
- **Owner:** deploying operator. **Window:** first ingest + first chat after deploy.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
