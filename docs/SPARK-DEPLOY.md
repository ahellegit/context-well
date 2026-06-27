# Deploying knowledgeLLM to the `spark` test box

A runbook for an agent (or human) to connect to the **spark** instance and deploy
the app. Self-contained: follow it top to bottom. No secrets are stored here —
the SSH password lives in the gitignored `.env` (see Prerequisites).

> ⚠️ Read `docs/CYBORGDB-ISSUES.md` too — it explains the embedding offline-mode
> and volume setup referenced below.

---

## Topology

Everything runs on the spark host via Docker, on the **host network**:

| Piece | Where | Notes |
|---|---|---|
| `knowledgellm` (the app) | container, port **3000** | built from this repo's `Dockerfile` |
| `cyborgdb-service` | container, port **8000** | image `cyborginc/cyborgdb-service:0.17.0`, disk mode |
| Ollama | runs on the spark **host**, port **11434** | external; the app reaches it at `http://localhost:11434` (host network) |

Persistent Docker volumes: `cyborgdb_data` (vector index), `cyborgdb_hf_cache`
(embedding model), `app_data` is the app's SQLite via a bind mount `~/knowledgellm-test/appdata`.
The deployed working copy of this repo lives at **`~/knowledgellm-test`** on spark.

---

## Prerequisites (on your machine)

1. **NordLayer VPN must be connected** — `spark.cyborg.nordlayerconnect.net` is
   only reachable over it. If SSH times out (`port 22: Operation timed out`),
   the VPN is down. (Auth failures, by contrast, mean a key/password problem.)
2. The repo's **`.env`** (gitignored) contains `OLLAMA_SERVER_PASSWORD=<spark login password>`.
   Read it from there; never print or commit it.
3. `python3` available locally (for the SSH runner below). `sshpass` is NOT
   needed and is usually absent on macOS.

Host + user: `cyborg@spark.cyborg.nordlayerconnect.net`.

---

## Connecting (password SSH without sshpass)

macOS has no `sshpass`, so use this stdlib-`pty` runner. Write it to a scratch
file once, then reuse it. It reads the password from `$PW` and feeds it to the
SSH password prompt; pass the remote command as a single argument.

```python
# sshrun.py
import os, pty, sys, select
pw = os.environ.get("PW","").encode()
host = "cyborg@spark.cyborg.nordlayerconnect.net"
remote = sys.argv[1]
key = os.environ.get("KEY")  # optional: path to a private key for key-auth
opts = ["-o","StrictHostKeyChecking=accept-new","-o","ConnectTimeout=15"]
if key:
    opts += ["-i", key, "-o", "IdentitiesOnly=yes", "-o", "PasswordAuthentication=no"]
argv = ["ssh"] + opts + [host, remote]
timeout = int(os.environ.get("T","120"))
pid, fd = pty.fork()
if pid == 0:
    os.execvp("ssh", argv)
else:
    sent = False; buf = b""
    while True:
        try: r,_,_ = select.select([fd], [], [], timeout)
        except select.error: break
        if not r: break
        try: data = os.read(fd, 4096)
        except OSError: break
        if not data: break
        buf += data; os.write(1, data)
        if not sent and not key and b"assword:" in buf:
            os.write(fd, pw + b"\n"); sent = True
    try: os.waitpid(pid, 0)
    except OSError: pass
```

Run a command on spark:

```bash
export PW=$(grep '^OLLAMA_SERVER_PASSWORD=' .env | cut -d= -f2-)
python3 sshrun.py 'docker ps --format "{{.Names}}: {{.Status}}"'
```

### Faster: install an ephemeral key (recommended for multi-step work)

Password SSH is fine but repetitive. Install a throwaway key once, then use
`KEY=…` (no password prompts), which also lets `rsync`/`scp` work:

```bash
export PW=$(grep '^OLLAMA_SERVER_PASSWORD=' .env | cut -d= -f2-)
ssh-keygen -t ed25519 -N '' -f /tmp/spark_key -C "knowledgellm-deploy-ephemeral"
PUB=$(cat /tmp/spark_key.pub)
python3 sshrun.py "install -d -m 700 ~/.ssh; printf '%s\n' '$PUB' >> ~/.ssh/authorized_keys; chmod 600 ~/.ssh/authorized_keys; sort -u ~/.ssh/authorized_keys -o ~/.ssh/authorized_keys; echo KEY_OK"
# then for everything after:
ssh -i /tmp/spark_key -o IdentitiesOnly=yes cyborg@spark.cyborg.nordlayerconnect.net 'echo ok'
```

Remove it when done: `sed -i '/knowledgellm-deploy-ephemeral/d' ~/.ssh/authorized_keys` on spark.

> The agent runtime's scratch dir is wiped between sessions, so the key and
> `sshrun.py` may need recreating each session. The `authorized_keys` entry on
> spark persists, but you'll have lost the matching private key — just reinstall
> a fresh key with the snippet above.

---

## Deploy a change (the normal flow)

The app image bakes in `dist/` + `public/`, so any code or frontend change needs
a rebuild + container recreate. `cyborgdb-service` is left running.

1. **Sync the working tree up** (key-auth shown; uses `-i /tmp/spark_key`):

```bash
rsync -az --delete \
  --exclude node_modules --exclude .git --exclude dist --exclude '*.db' --exclude appdata \
  -e "ssh -i /tmp/spark_key -o IdentitiesOnly=yes" \
  ./ cyborg@spark.cyborg.nordlayerconnect.net:~/knowledgellm-test/
```

2. **Run the redeploy script on spark** (see `redeploy.sh` below; it lives at
   `~/redeploy.sh` on spark). The build takes a few minutes on ARM, so run it
   **detached** and poll — do not block on it:

```bash
KEY=/tmp/spark_key python3 sshrun.py 'nohup bash ~/redeploy.sh >~/redeploy.out 2>&1 & echo LAUNCHED'
# poll until done:
KEY=/tmp/spark_key T=200 python3 sshrun.py 'until grep -aq REDEPLOY_DONE ~/redeploy.out 2>/dev/null; do sleep 4; done; tail -3 ~/redeploy.out; curl -s -o /dev/null -w "health=%{http_code}\n" http://localhost:3000/api/health'
```

> **Why detached?** A foreground SSH that runs longer than the caller's command
> timeout (the agent harness kills at ~2 min) will be cut off mid-build. `nohup …
> &` + poll-the-logfile survives that.

### `redeploy.sh` (lives at `~/redeploy.sh` on spark — recreate if missing)

```bash
#!/usr/bin/env bash
set -uo pipefail
cd ~/knowledgellm-test
docker build -t knowledgellm . >/tmp/redeploy.log 2>&1 && echo "build=ok" || { echo "build=FAIL"; tail -25 /tmp/redeploy.log; exit 1; }
# Persist the session secret so logins survive redeploys (don't regenerate it).
SECRET_FILE=~/.knowledgellm-session-secret
[ -f "$SECRET_FILE" ] || openssl rand -hex 32 > "$SECRET_FILE"
docker rm -f knowledgellm >/dev/null 2>&1
docker run -d --name knowledgellm --network host --restart unless-stopped \
  -e SESSION_SECRET="$(cat "$SECRET_FILE")" \
  -e CYBORGDB_URL=http://localhost:8000 \
  -e DATABASE_URL=file:/data/app.db \
  -e ALLOW_REGISTRATION=true \
  -v "$PWD/appdata:/data" \
  knowledgellm >/dev/null 2>&1
ok=0; for i in $(seq 1 60); do curl -sf http://localhost:3000/api/health >/dev/null 2>&1 && { ok=1; break; }; sleep 2; done
echo "app_health=$ok"
echo "REDEPLOY_DONE"
```

To (re)create it on spark: write the block above to `~/redeploy.sh` (e.g. rsync
it up, or `cat > ~/redeploy.sh <<'EOF' … EOF`).

---

## First-time / full bringup (only if `cyborgdb-service` isn't running)

```bash
# 1. cyborgdb-service with persistent volumes, offline embedding, restart policy.
#    FIRST EVER run: set HF_HUB_OFFLINE=0 so the embedding model downloads into
#    the cache volume, do one query/upload to warm it, THEN recreate with =1.
docker run -d --name cyborgdb --network host --restart unless-stopped \
  -e CYBORGDB_DB_TYPE=disk -e CYBORGDB_DISK_PATH=/app/cyborgdb_data \
  -e HF_HUB_OFFLINE=1 -e TRANSFORMERS_OFFLINE=1 \
  -v cyborgdb_data:/app/cyborgdb_data \
  -v cyborgdb_hf_cache:/home/cyborguser/.cache/huggingface \
  cyborginc/cyborgdb-service:0.17.0
# wait for health: curl http://localhost:8000/v1/health
# 2. then run redeploy.sh for the app (above).
```

No CyborgDB keys are needed (auth disabled + free tier). Offline mode (`HF_HUB_OFFLINE=1`)
is the ~35× embedding speedup — see `docs/CYBORGDB-ISSUES.md` #1.

---

## Ollama (on the spark host, not in a container)

- The app's chat model is set in-app (Settings) to a model Ollama has, currently
  `qwen3.6:35b`. The app sends `think:false` + `num_ctx:8192` + `keep_alive:30m`.
- Requires **Ollama ≥ 0.30** for the `qwen35moe` arch (0.17 can't load it). Upgrade:
  `curl -fsSL https://ollama.com/install.sh | sh` (needs sudo — the spark login
  password works with `sudo -S`).
- A smaller model (e.g. `ollama pull qwen2.5:7b`) gives much faster first-token if
  desired; set it in the app's Settings.

---

## View the UI from your machine

spark is headless. Tunnel the app port and open it locally:

```bash
ssh -L 3000:localhost:3000 cyborg@spark.cyborg.nordlayerconnect.net
# then open http://localhost:3000
```

The `localhost:3000` tunnel dies whenever the VPN/SSH session drops — reopen it
if the page stops loading (the container is almost certainly still fine; check
`docker ps` + `/api/health`).

---

## Verify / smoke test

```bash
# containers + health
KEY=/tmp/spark_key python3 sshrun.py 'docker ps --format "{{.Names}}: {{.Status}}"; echo H=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/health)'
```

A fuller curl smoke test (register/login → settings → create space → chat) lives in
the project history; the key signals are: `/api/health` → 200, `test-ollama`
discovers models, creating a space succeeds (index provisioned), and a chat turn
streams `token` events ending in `done`.

---

## Gotchas (learned the hard way)

- **2-minute command cap:** any SSH command that builds/loads a model will exceed
  the agent harness's ~2-min limit. Always `nohup … &` + poll a logfile.
- **First query after a (re)start is ~2s slower** — one-time embedding-model load.
- **First chat after >`keep_alive` idle** reloads the model (~30–40s on the 36B).
- **`cyborgdb` has no published image data** — its index lives only in the
  `cyborgdb_data` volume. Never `docker rm` it without that volume mounted, or
  recreate from a `docker commit` snapshot, or you lose all indexes.
- **DNS blips on `github.com`** can fail a push mid-VPN-reconnect — just retry.
- **Git push from this repo** uses the keyring gh account, not the env token:
  `env -u GITHUB_TOKEN -u GH_TOKEN git -c credential.helper='!gh auth git-credential' push`.
