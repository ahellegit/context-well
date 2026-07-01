# Context Well

Self-hosted, private context/RAG for your LLM. The app pairs a chat UI with an
encrypted vector index ([CyborgDB](https://www.cyborg.co/)) and a local
[Ollama](https://ollama.com/) for chat — your data never leaves your machine.

## Quickstart (Docker — zero config)

You need [Docker](https://docs.docker.com/get-docker/) and a running
[Ollama](https://ollama.com/download) with at least one chat model pulled:

```bash
ollama pull mistral-small      # or any chat model you prefer
```

Then, from this directory:

```bash
docker compose up -d
```

That's it — **no `.env` to create, no secrets to generate.** Open
**http://localhost:3000** and finish setup in the UI:

1. Create the first admin account.
2. Connect Ollama — the URL is pre-filled (`http://host.docker.internal:11434`);
   click **Test connection** and pick your chat model.
3. Create a workspace and start adding context.

The stack starts three things: the app, `cyborgdb-service` (the encrypted vector
index), and a one-shot init that fixes volume permissions. All data persists in
named Docker volumes, so it survives restarts.

On a different machine on your LAN, use that host's IP instead of `localhost`
(e.g. `http://192.168.0.171:3000`).

### Useful commands

```bash
docker compose logs -f app     # watch app logs
docker compose ps              # container status
docker compose down            # stop (keeps your data)
docker compose down -v         # stop and delete all data (fresh start)
docker compose up -d --build   # rebuild after pulling code changes
```

## Configuration

One variable is **required**: `PRISMA_FIELD_ENCRYPTION_KEY`, the master key for
at-rest encryption (see [Security](#security-encryption-at-rest)). The app
refuses to boot without it. Generate one and put it in `.env`:

```bash
npx cloak generate            # → k1.aesgcm256.<base64>
echo "PRISMA_FIELD_ENCRYPTION_KEY=k1.aesgcm256..." >> .env
```

Everything else has a working default. Create a `.env` (copy `.env.example`) to
override one — for example:

- `SESSION_SECRET` — a random one is generated and persisted automatically; set
  this to pin it explicitly (e.g. to share sessions across replicas).
- `OLLAMA_DEFAULT_URL` — point the wizard at a remote Ollama instead of the
  local host. Note: the app refuses private IP literals (SSRF guard); use a
  hostname.
- `PORT`, `COOKIE_SECURE`, `ALLOW_REGISTRATION` — see `.env.example`.

CyborgDB runs locally with auth disabled and on the free tier — no keys needed.
See `docs/CYBORGDB-ISSUES.md` for operational notes.

## Local development (without Docker)

```bash
npm install
npx prisma migrate deploy
npm run dev                    # http://localhost:3000
```

Requires a reachable `cyborgdb-service` (`CYBORGDB_URL`, default
`http://localhost:8000`) and Ollama. In this mode local Ollama is
`http://localhost:11434`.

## Security: encryption at rest

Context Well encrypts sensitive data at rest at the application layer, so a
stolen database file or disk snapshot is useless without the master key.

**Threat model.** Protects against an actor with a copy of the data — a lost
volume, a leaked backup, a raw `app.db` dump, or filesystem/cloud-provider
access. It does not defend against an attacker with live access to the running
process's memory (a server must decrypt to serve queries).

**What is encrypted** (AES-256-GCM via
[`prisma-field-encryption`](https://github.com/47ng/prisma-field-encryption)):
chat messages and cited snippets, connector credentials (GitHub/Slack tokens),
conversation/document titles, document metadata, space custom prompts, and — 
critically — the per-space **CyborgDB index keys**, so the encrypted embeddings
can't be decrypted from a DB dump. Vector embeddings themselves are already
encrypted at rest by CyborgDB.

**The master key.** Set `PRISMA_FIELD_ENCRYPTION_KEY` (format
`k1.aesgcm256.<base64>`, via `npx cloak generate`). It is validated at boot and
is **required** — the app will not start without it. It is injected from the
environment and deliberately never generated onto or stored on the data volume;
that is why `docker compose up` is not zero-config for this one value. **Back the
key up** — losing it makes encrypted data unrecoverable.

**Rotation.** Set a new key in `PRISMA_FIELD_ENCRYPTION_KEY`, move the old key
into `PRISMA_FIELD_DECRYPTION_KEYS` (comma-separated) so existing data still
decrypts, then re-encrypt with `npx tsx scripts/backfill-encryption.ts`.

**Enabling on an existing database.** Deploy the new build, then run
`npx tsx scripts/backfill-encryption.ts` once to encrypt pre-existing rows. Order
doesn't matter: legacy plaintext rows are read through transparently until
re-encrypted.

**Residual (disk-encryption only).** `User.email` (a unique login-lookup key, so
it can't use randomized encryption) and `Session.id` (short-lived; the cookie is
already signed) are not app-encrypted. Run the deployment on an encrypted volume
to cover them.
