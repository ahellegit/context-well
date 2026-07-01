---
title: "feat: Encryption at rest for sensitive SQLite data"
date: 2026-06-30
type: feat
origin: docs/brainstorms/2026-06-30-encryption-at-rest-requirements.md
depth: deep
status: ready
---

# feat: Encryption at Rest for Sensitive SQLite Data

## Summary

Context Well encrypts embeddings at rest via CyborgDB, but everything else in the app's
SQLite database is plaintext — including, critically, the per-space CyborgDB index keys,
which means a stolen `app.db` decrypts the "encrypted" embeddings. This plan adds
transparent, app-layer AES-256-GCM field encryption to the sensitive columns, keyed by a
master key injected from the environment and never written to the database, so a stolen DB
file or disk snapshot is useless on its own.

Mechanism: adopt [`prisma-field-encryption`](https://github.com/47ng/prisma-field-encryption)
(a Prisma 6 `$extends()` extension) rather than hand-rolling interception. It encrypts
declared fields on write and decrypts on read, supports key rotation via multiple decryption
keys, and passes legacy plaintext through untouched on read — which lets us deploy the
extension and backfill existing rows in any order.

---

## Problem Frame

Under an untrusted-host / cloud-provider threat model (see origin: `docs/brainstorms/2026-06-30-encryption-at-rest-requirements.md`),
an actor with filesystem access, a leaked backup, or a raw `app.db` dump can read every
sensitive value the app persists. Verified plaintext surfaces in `prisma/schema.prisma`:

- `Space.indexKey` (schema line 87, flagged `KTD5`) — the 32-byte CyborgDB key, hex-encoded.
  **This is the critical hole: it decrypts the embeddings CyborgDB protects.**
- `Connector.credentials` (line 102) — GitHub PATs, Slack `xoxb-` bot tokens.
- `Message.text` / `Message.sources` (lines 161, 163) — chat content and cited snippets.
- `Conversation.title` (line 147), `Document.title` / `Document.metadata` (lines 120-121),
  `Space.customPrompt` (line 85) — content-bearing metadata.

Out of scope (decided in origin): `User.email` (`@unique`, used for login lookup — stays
plaintext, protected by disk encryption) and `Session.id` (short-lived, cookie already
signed). Already safe (verified): document/chunk text lives only in CyborgDB; there is no
file/object store; `SystemSetting.value` holds only the Ollama URL.

---

## Requirements

- **R1** — A stolen `app.db` reveals no chat content, connector secret, or usable CyborgDB
  index key.
- **R2** — The embedding-at-rest guarantee is restored end-to-end (index keys no longer
  plaintext), and CyborgDB queries still succeed.
- **R3** — The master key is read from the environment, validated at boot, and never
  persisted to the database (or auto-persisted to the data volume).
- **R4** — Encryption is applied at a single centralized layer so no write path can silently
  persist plaintext.
- **R5** — Key rotation is possible without a schema migration.
- **R6** — Existing rows are encrypted by a one-time, idempotent backfill; rollout order
  between deploy and backfill does not matter (legacy plaintext reads pass through).

---

## Key Technical Decisions

### KTD-1 — Adopt `prisma-field-encryption` rather than hand-roll
The library uses AES-256-GCM with 256-bit keys via `$extends()` — the exact mechanism the
origin recommended — but ships the parts that are risky to hand-roll: interception of every
write shape (`create`, `createMany`, `update`, `updateMany`, `upsert`, nested writes),
key rotation, and legacy-plaintext passthrough. Chosen over a custom node:crypto extension
to avoid re-implementing security-critical interception. (Confirmed with user, 2026-06-30.)
See Alternatives Considered.

### KTD-2 — The env master key is the KEK; `indexKey` is just another encrypted field
The origin's "master key wraps the per-space index key" reduces, mechanically, to encrypting
the `Space.indexKey` column like any other field. On read it decrypts to the hex string, and
the existing `hexToKey()` (`src/cyborg/client.ts:34`) converts it for the SDK unchanged. One
uniform mechanism for all fields; no bespoke wrapping code.

### KTD-3 — Master key is env-only with hard boot failure; no volume auto-persist
`src/config.ts` already auto-generates and persists a `session.secret` next to the DB
(`src/config.ts:42-63`). We deliberately do **not** reuse that pattern for the master key:
persisting it on the same volume as `app.db` defeats the untrusted-host model. The key
(`PRISMA_FIELD_ENCRYPTION_KEY`) is required; `loadConfig()` validates its presence and format
and throws at boot if missing/malformed, before the library would lazily error on first write.

### KTD-4 — Randomized encryption; encrypted fields are never query predicates
AES-GCM uses a random IV, so ciphertext is non-deterministic and cannot appear in a `where`,
`orderBy`, or unique lookup. All in-scope fields are fetched by id/relation today, never
filtered by content. U6 adds an audit test to keep it that way. `User.email` is excluded
precisely because it is a `@unique` lookup key (would require a blind index; deferred).

### KTD-5 — Rotation via `PRISMA_FIELD_DECRYPTION_KEYS`
The library decrypts with any key in the decryption set and encrypts with the current key, so
rotation is: add the new key as current, keep the old in the decryption set, re-save rows
(reuse the U5 backfill). No schema migration. Satisfies R5.

---

## High-Level Technical Design

```mermaid
flowchart LR
  subgraph App["App process"]
    svc["services\n(spaces / chat / connectors)"]
    ext["Prisma client + fieldEncryptionExtension\n(src/db/client.ts)"]
    cfg["config.ts\nvalidates master key at boot"]
  end
  subgraph Env["Injected secret (not on DB volume)"]
    key["PRISMA_FIELD_ENCRYPTION_KEY"]
  end
  db[("SQLite app.db\nciphertext at rest")]
  cyborg[("CyborgDB\nencrypted vectors")]

  key -.validated by.-> cfg
  key -.used by.-> ext
  svc -->|plaintext in memory| ext
  ext -->|encrypt on write / decrypt on read| db
  svc -->|hexToKey(decrypted indexKey)| cyborg
```

Read path returns plaintext to services (or passes legacy plaintext through unchanged);
write path encrypts declared fields transparently. Services and the CyborgDB call site are
unchanged — `indexKey` still arrives as hex.

---

## Implementation Units

### U1. Master-key config and validation
**Goal:** Load and validate the encryption master key from the environment; fail loudly at
boot if absent or malformed. (R3)
**Dependencies:** none.
**Files:** `src/config.ts`, `src/__tests__/config.test.ts` (or existing config test), `.env.example`.
**Approach:** Add `encryptionKey` to `Config`. Read `PRISMA_FIELD_ENCRYPTION_KEY` via
`required(...)` so a missing key throws the existing "Missing required environment variable"
error. Validate it matches the library's expected key format (`k1.aesgcm256.<base64>`); throw
a clear error if not. Do **not** add any load-or-create-and-persist fallback (contrast
`loadOrCreatePersistedSecret`). Document the variable and how to generate a key in
`.env.example`. Note the `CYBORGDB_URL`-style `required()` precedent.
**Patterns to follow:** `required()` and the `Config` interface in `src/config.ts:16-87`.
**Test scenarios:**
- Covers R3. Missing `PRISMA_FIELD_ENCRYPTION_KEY` → `loadConfig()` throws at boot.
- Malformed key (wrong prefix / not base64 / wrong length) → throws with a clear message.
- Valid key → `config.encryptionKey` populated; no file is written to the DB directory.
**Verification:** App refuses to boot without a valid key; a valid key boots cleanly.

### U2. Wire the field-encryption extension into the Prisma client
**Goal:** Centralize encryption at the single Prisma client seam. (R4)
**Dependencies:** U1.
**Files:** `package.json` (add `prisma-field-encryption`), `src/db/client.ts`,
`src/db/__tests__/client.test.ts`.
**Approach:** Extend the shared client with `fieldEncryptionExtension()` in
`src/db/client.ts` so every caller of `prisma` goes through it. The library reads the key
from the environment; U1 guarantees it is present. Export the extended client as `prisma`
(unchanged import site for all services). Confirm the extension composes with the plain
`new PrismaClient()` currently exported.
**Patterns to follow:** existing singleton in `src/db/client.ts`.
**Test scenarios:**
- The exported `prisma` is the extended client (encryption active) — a write to an annotated
  field (see U3) stores ciphertext.
- Non-annotated fields (e.g. `Space.name`) are stored and read unchanged.
- Reading a row whose annotated field holds legacy plaintext returns it unchanged (passthrough).
**Verification:** All services keep importing `prisma` from `src/db/client.ts`; encryption is
transparent to them.

### U3. Annotate content and credential fields for encryption
**Goal:** Encrypt connector credentials, chat content, and content-bearing metadata at rest.
(R1)
**Dependencies:** U2.
**Files:** `prisma/schema.prisma`, generated client (`prisma generate`),
`src/connectors/__tests__/*`, `src/chat/__tests__/*` or `src/spaces/__tests__/*`.
**Approach:** Add the library's `/// @encrypted` annotation to: `Connector.credentials`,
`Message.text`, `Message.sources`, `Conversation.title`, `Document.title`,
`Document.metadata`, `Space.customPrompt`. Regenerate the client. No service code changes —
values are encrypted on write, decrypted on read. Note empty-string defaults
(`customPrompt @default("")`, `title @default("New chat")`) — confirm the library handles
empty/whitespace values without error.
**Patterns to follow:** existing schema comments in `prisma/schema.prisma`.
**Test scenarios:**
- Covers R1. Creating a `Connector` → a raw SQL read of the `credentials` column returns
  ciphertext, not the token; reading via `prisma` returns the plaintext token.
- Persisting a `Message` → raw `text` and `sources` columns are ciphertext; round-trip via
  `prisma` returns original text and parseable `sources` JSON.
- `Conversation.title`, `Document.title`/`metadata`, `Space.customPrompt` round-trip; raw
  columns are ciphertext.
- Empty-default row (new conversation, empty custom prompt) persists and reads back without
  error.
- Connector browser-masking (`maskCredentials`) still returns masked output (no regression).
**Verification:** Inspecting `app.db` shows ciphertext for these columns; app behavior
unchanged.

### U4. Encrypt `Space.indexKey` and verify the CyborgDB path end-to-end
**Goal:** Close the critical hole — the CyborgDB index key is no longer plaintext — while
keeping vector queries working. (R2)
**Dependencies:** U2.
**Files:** `prisma/schema.prisma` (annotate `Space.indexKey`; update the `KTD5` comment on
line 86), `src/cyborg/__tests__/*` or an integration test exercising space create → load.
**Approach:** Add `/// @encrypted` to `Space.indexKey`. `provisionIndex` writes the hex key
as today; the extension encrypts it. On read, the extension decrypts to hex and the existing
`hexToKey()` (`src/cyborg/client.ts:34`) feeds the SDK unchanged. Verify no double-encoding
and that `keyToHex`/`hexToKey` still round-trip through the encrypted column. Kept separate
from U3 because this field carries the embedding-encryption guarantee and warrants an
end-to-end check, not just a column assertion.
**Patterns to follow:** `keyToHex`/`hexToKey` and `loadIndex` usage in `src/cyborg/client.ts`.
**Test scenarios:**
- Covers R2. Provision a space → raw `indexKey` column is ciphertext (not 64 hex chars).
- Read the space via `prisma` → `indexKey` is the original hex; `hexToKey()` yields a 32-byte
  key.
- End-to-end: create space → ingest/upsert a vector → query → results return (the decrypted
  key loads the CyborgDB index successfully).
- A space row with legacy plaintext hex (pre-backfill) still loads its index (passthrough).
**Verification:** `app.db` shows no readable index key; CyborgDB retrieval works before and
after backfill.

### U5. One-time idempotent backfill of existing rows
**Goal:** Encrypt data already stored in plaintext. (R6)
**Dependencies:** U3, U4.
**Files:** `scripts/backfill-encryption.ts` (new), `scripts/__tests__/backfill-encryption.test.ts`.
**Approach:** For each model with encrypted fields, read all rows through the extended
`prisma` (legacy plaintext passes through; already-encrypted decrypts) and write each row
back with the same values, which re-persists through the extension and encrypts. Idempotent:
re-running encrypts already-encrypted rows harmlessly (read decrypts, write re-encrypts).
Process in batches; log counts per model. Because reads pass legacy plaintext through, the
script is safe to run before or after the extension is deployed (R6).
**Patterns to follow:** existing `prisma` usage; script style under repo scripts if present.
**Test scenarios:**
- Covers R6. Seed a row with plaintext in an encrypted column → run backfill → raw column is
  ciphertext, value unchanged via `prisma`.
- Idempotency: run backfill twice → second run leaves values readable and correct.
- Mixed table (some rows already encrypted, some legacy) → all end encrypted, all readable.
**Verification:** After running, no in-scope column in `app.db` contains readable plaintext.

### U6. Query-safety audit and security-posture documentation
**Goal:** Guarantee encrypted fields are never used as query predicates, and document the
residual disk-encryption requirement. (KTD-4, R3)
**Dependencies:** U3, U4.
**Files:** `src/db/__tests__/encrypted-fields-query-safety.test.ts` (new), `README.md` (security
section), `.env.example` (already touched in U1).
**Approach:** Add a test/audit that fails if any encrypted field appears in a `where`,
`orderBy`, `distinct`, or unique-selector across the codebase (static grep-style scan over
`src/**` for the field names in query positions, or an assertion listing the known safe query
sites). Document in `README.md`: the threat model, that the master key must be injected and
kept off the DB volume, key rotation steps, and that `User.email` and `Session.id` rely on
disk encryption of the deployment.
**Patterns to follow:** existing test layout under `src/**/__tests__`.
**Test scenarios:**
- Audit passes for the current codebase (no encrypted field in a predicate).
- Introducing a `where: { credentials: ... }` (fixture) makes the audit fail.
- `Test expectation: docs portion has none` — README/`.env.example` changes are documentation.
**Verification:** Audit is green; README states the posture and rotation procedure.

---

## Scope Boundaries

**In scope:** transparent field encryption for `Space.indexKey`, `Connector.credentials`,
`Message.text`/`sources`, `Conversation.title`, `Document.title`/`metadata`,
`Space.customPrompt`; master-key config; backfill; query-safety audit; posture docs.

### Deferred for later (from origin)
- Encrypting `User.email` via a blind index (deterministic HMAC lookup + encrypted value).
  Deferred because it is a `@unique` login-lookup key; revisit if email-at-rest becomes a hard
  requirement.
- Encrypting `Session.id` (short-lived; cookie already signed).

### Deferred to Follow-Up Work
- External KMS / Vault backend for the master key. KTD-3 keeps the key env-injected; the
  library's env-key seam is where a KMS-sourced key would later be supplied.
- Per-tenant (per-space) key isolation. The uniform env-key model does not preclude it later.

---

## Alternatives Considered

- **Hand-rolled node:crypto helper + custom Prisma extension** (the origin's original sketch).
  Rejected as primary: re-implements write-path interception (`createMany`/`upsert`/nested
  writes), rotation, and legacy passthrough — all security-critical and all already provided
  and tested by `prisma-field-encryption`. The custom "envelope/KEK" framing added no
  capability the library's env key + rotation set does not cover.
- **Deterministic (searchable) field encryption** (e.g. a blind-index library). Only needed
  for fields used as query predicates; none of the in-scope fields are, and `email` (the one
  that is) is deferred. Not adopted now.
- **SQLCipher / full-DB-file encryption.** Encrypts the whole file with one key but leaves
  plaintext in memory-mapped pages and does not give per-field rotation or the CyborgDB-key
  isolation we want; also a larger operational change to the SQLite datasource. Not adopted.

---

## Risks & Dependencies

- **Write-path coverage risk.** If any sensitive value is written through a path the extension
  does not intercept (raw SQL via `$executeRaw`, a bulk import), it lands in plaintext. Mitigation:
  U6 audit; grep for `$executeRaw`/`$queryRaw` touching these columns during implementation.
- **Empty/default values.** `customPrompt`/`title` default to empty strings — confirm the
  library encrypts or safely skips them (U3 test).
- **Backfill vs. reads during rollout.** Mitigated by design: legacy plaintext passes through
  on read (R6), so there is no window where reads fail.
- **Key loss = data loss.** Losing `PRISMA_FIELD_ENCRYPTION_KEY` makes encrypted fields
  unrecoverable (this is the point). Document key-backup responsibility in README (U6); this is
  the same failure class as AnythingLLM issue #5256, avoided by not auto-rotating/regenerating.
- **Dependency:** `prisma-field-encryption` compatible with `@prisma/client ^6.2.1` (verified
  as extension-based for Prisma 6). Pin the version.

---

## Sources & Research

- Origin requirements: `docs/brainstorms/2026-06-30-encryption-at-rest-requirements.md`
- Data surface verified against `prisma/schema.prisma`, `src/config.ts`,
  `src/cyborg/client.ts`, `src/db/client.ts`.
- [`prisma-field-encryption` (47ng)](https://github.com/47ng/prisma-field-encryption) —
  AES-256-GCM, Prisma 6 `$extends()`, key rotation via decryption-key set, legacy-plaintext
  passthrough. Load-bearing: flipped KTD-1 from build to buy.
