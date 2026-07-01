# Encryption at Rest — Requirements

**Date:** 2026-06-30
**Status:** Ready for planning
**Scope:** Deep — feature

## Problem

Context Well encrypts embeddings at rest via CyborgDB, but everything else persisted to
the app's SQLite database (`prisma/schema.prisma`, SQLite file at `/data/app.db` in
Docker) is plaintext. Under an untrusted-host threat model, a stolen database file or disk
snapshot exposes chat content, connector secrets, and — most damagingly — the CyborgDB
index keys themselves, which nullifies the embedding-at-rest guarantee.

## Threat model

Defend against a **compromised host / cloud provider**: an actor with filesystem access,
a leaked backup, or a raw dump of `app.db`. The running server must decrypt to serve
queries, so the realistic goal is: **keys never sit next to the data, and a stolen DB or
disk is useless without a key the DB does not contain.**

Out of scope: defending against an attacker with live access to the running process's
memory/environment (unachievable for a server that must decrypt to function).

## Key custody (decided)

- A **single master key**, injected via environment variable / mounted secret, **never
  written to the database**.
- The master key acts as a **Key-Encryption-Key (KEK)**: it wraps the per-space CyborgDB
  index keys (which are already per-space data keys) and encrypts other sensitive fields.
- No external KMS dependency in v1; the key-provider boundary should be thin enough that a
  KMS/Vault backend can replace the injected key later without re-architecting.

## The at-rest surface (verified against schema)

| # | Data | Location | Today | In scope |
|---|------|----------|-------|----------|
| 1 | CyborgDB per-space index key | `Space.indexKey` (`prisma/schema.prisma:86`, `KTD5`) | plaintext | **Yes — critical** |
| 2 | Connector credentials (GitHub PAT, Slack `xoxb-`) | `Connector.credentials` (`prisma/schema.prisma:102`) | plaintext | **Yes** |
| 3 | Chat content + retrieved snippets | `Message.text`, `Message.sources` (`prisma/schema.prisma:156-167`) | plaintext | **Yes** |
| 4 | Content-bearing metadata | `Conversation.title`, `Document.title`/`metadata`, `Space.customPrompt` | plaintext | **Yes** |
| 5 | PII | `User.email` (`@unique`, login lookup) | plaintext | **No — disk-only** (see below) |
| 6 | Session tokens | `Session.id` | plaintext (cookie signed) | No — expire; low value |

**Item 1 is the priority.** Encrypting chats while `Space.indexKey` stays plaintext would
leave the key to the encrypted embeddings sitting beside them in the same DB file.

### Already covered (verified — no action)

- Raw document/chunk text lives **only** in CyborgDB (encrypted); never in SQL
  (`src/uploads/service.ts`, `src/cyborg/index-service.ts`).
- **No file/object store** — uploads stream straight to CyborgDB; nothing persisted to disk
  (`src/uploads/routes.ts`).
- `SystemSetting.value` holds only the Ollama URL + model name — no secrets
  (`src/settings/service.ts`).
- `User.passwordHash` is argon2id (hashing, not an encryption target).

## Goals

- A DB dump or disk snapshot of `app.db` alone reveals no chat content, no connector
  secrets, and no usable CyborgDB index keys.
- The embedding-at-rest guarantee is restored end-to-end (index keys no longer plaintext).
- Encryption is centralized so no write path can silently persist plaintext.
- Key rotation is possible without a data migration.

## Non-goals

- Defending against a live in-memory/process compromise of the running server.
- External KMS/Vault integration in v1 (design the seam; don't build the backend yet).
- Encrypting `User.email` at the application layer (kept searchable; see Assumptions).
- Per-tenant key isolation as a v1 requirement (the KEK framing keeps it as a later option).

## Requirements

1. Provide an AES-256-GCM encrypt/decrypt helper keyed by the injected master key. Every
   ciphertext is **version-tagged** (e.g. a `v1:` prefix or key-id) so rotation re-wraps
   rather than migrates.
2. The master key is read from env/secret at startup; absence is a hard startup failure (no
   silent plaintext fallback). It is never persisted to the database.
3. **Wrap `Space.indexKey`** with the KEK. Unwrap only in-memory when supplying the key to
   CyborgDB (`src/cyborg/client.ts`). Clears `KTD5`.
4. Encrypt `Connector.credentials` at rest; decrypt only server-side when a connector runs.
   Browser masking (`maskCredentials`) is unchanged.
5. Encrypt `Message.text` and `Message.sources` at rest.
6. Encrypt `Conversation.title`, `Document.title`, `Document.metadata`, and
   `Space.customPrompt` at rest.
7. Encryption is applied at a **single centralized layer** (recommended: a Prisma client
   extension declaring encrypted fields) so services cannot forget it on a write path.
8. Provide a one-time migration/backfill that encrypts existing rows for all in-scope fields.

## Approach (recommended)

- **Mechanism:** transparent field encryption via a Prisma client extension — declared
  encrypted columns are encrypted on write and decrypted on read. Chosen over per-service
  explicit calls because a missed call silently stores plaintext, which the threat model
  cannot tolerate.
- **Key model:** the injected master key is a KEK. `Space.indexKey` is wrapped by it; other
  fields are encrypted under the KEK (or an HKDF-derived subkey). One coherent scheme, and a
  clean upgrade path to per-tenant keys / KMS later.
- Classify as **build net-new** (no crypto helper or KMS lib exists today — only `argon2`
  for hashing and a session secret persisted at mode `0o600` in `src/config.ts`).

## Success criteria

- Dumping `app.db` and inspecting rows shows ciphertext for all in-scope fields; no chat
  text, connector token, or index key is readable.
- CyborgDB queries still succeed (index key unwraps correctly at runtime).
- Rotating the master key (with old key retained for unwrap) re-encrypts data without a
  schema migration.
- Startup fails loudly if the master key is missing or malformed.

## Dependencies / Assumptions

- **`User.email` stays plaintext** in the DB, protected only by disk encryption. Rationale:
  it is `@unique` and used for login lookup; randomized encryption breaks the index. The
  deployment is assumed to run on an encrypted volume for this residual field. (Revisit with
  a blind index if email-at-rest becomes a hard requirement.)
- Session tokens (`Session.id`) are left plaintext (short-lived; cookie already signed).
- A single injected master key is available in all environments (dev, Docker, prod).
- Assumes disk encryption is the operator's responsibility for anything not app-encrypted;
  this should be stated in deployment docs / README.

## Outstanding questions (for planning)

- Migration ordering for `Space.indexKey`: wrap existing keys before or during the same
  deploy that adds unwrap-on-load — must avoid a window where CyborgDB gets a wrapped key.
- Exact ciphertext envelope format (prefix vs. structured JSON) and how key-id is recorded
  for rotation.
- Whether `Message.sources` (JSON) is encrypted whole or per-field.
- Where the master key is sourced in dev to keep local workflow low-friction.

## Handoff

Ready for `/ce-plan`. The critical item (`Space.indexKey`, item 1) can be pulled forward as
a standalone security fix if desired, since it independently undermines the existing
embedding-encryption guarantee.
