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

## Optional configuration

Everything works out of the box. Create a `.env` (copy `.env.example`) **only**
to override a default — for example:

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
