# CyborgDB integration issues

Issues hit while building knowledgeLLM on `cyborgdb-service` + the `cyborgdb` (cyborgdb-js) SDK. Kept as feedback for the CyborgDB team and as gotchas for anyone integrating. Versions in play: **`cyborgdb` npm 0.17.0**, **`cyborgdb-service:0.17.0`** (Docker), Node 22, deployed on an NVIDIA GB10 (arm64).

Severity legend: 🔴 blocks/major perf · 🟠 correctness/DX trap · 🟡 minor/docs.

---

## 1. 🔴 Per-query HuggingFace round-trips make embedding ~35× slower than it should be
- **Symptom:** Every text `query()` / `upsert()` took ~2.25s even for one short string against a tiny index.
- **Root cause:** The service embeds with `sentence-transformers` (all-MiniLM-L6-v2) in **online mode**. On every embed it makes ~25 HTTP `HEAD`/`GET` calls to `huggingface.co` to re-validate the already-cached model (~1.6s of network round-trips per query). Confirmed in the service logs.
- **Impact:** ~2.2s added to every chat turn and every ingest chunk batch.
- **Fix / workaround:** Run the embedder offline — set **`HF_HUB_OFFLINE=1`** and **`TRANSFORMERS_OFFLINE=1`** on the `cyborgdb-service` container (model must already be cached). Warm query latency dropped **2250 ms → ~65 ms**.
- **Upstream:** `cyborgdb-service` should default to offline once the model is cached (or expose a flag), and ideally pre-bundle/pre-warm the embedding model in the image. As shipped, the default online behavior silently costs ~2s/query.

## 2. 🔴 First query after start pays a one-time embedding-model load (~2s)
- **Symptom:** The first text query/upsert after the service starts takes ~2s; subsequent ones are ~65ms.
- **Root cause:** sentence-transformers loads the model into memory lazily on first use.
- **Impact:** Cold-start latency; also means a fresh deploy's first user action is slow.
- **Fix / workaround:** Accept the one-time cost, or pre-warm with a throwaway embed call at startup. Combine with offline mode (#1).
- **Upstream:** A startup pre-warm (or a readiness probe that waits for the model) would make first-request latency predictable.

## 3. 🔴 `cyborgdb` npm package has an undeclared runtime dependency on `@langchain/core`
- **Symptom:** Importing the SDK (`src/cyborg/*`) crashed at runtime with a missing-module error; a fresh `npm install` of `cyborgdb` alone does not pull it.
- **Root cause:** `cyborgdb`'s `package.json` declares **no `dependencies` and no `peerDependencies`**, yet the code imports `@langchain/core` at runtime.
- **Impact:** The SDK is unusable until the consumer manually adds `@langchain/core`. Broke our Docker build until we declared it.
- **Fix / workaround:** Add `@langchain/core` to our app's dependencies explicitly.
- **Upstream:** `cyborgdb-js` should declare `@langchain/core` as a dependency (or peerDependency), or stop importing it.

## 4. 🟠 `query()` returns only vector IDs unless you pass `include`
- **Symptom:** Query results came back as bare `{ id }` — no scores, no metadata — so citations/snippets/threshold filtering had nothing to work with.
- **Root cause:** `query()` defaults to IDs only; you must pass `include: ["distance","metadata"]` (and there is no `"contents"` include — see #6).
- **Fix / workaround:** Always pass `include: ["distance","metadata"]`.
- **Upstream:** Easy to miss; a sensible default or a louder doc note would help.

## 5. 🟠 Results expose `distance`, not a similarity score — and `metric` has no default
- **Symptom:** Our "similarity ≥ threshold" filter was inverted-prone; thresholds tuned as "scores" didn't behave.
- **Root cause:** `QueryResultItem.distance` is a distance (smaller = more similar), not a 0–1 similarity. Separately, `createIndex({ metric })` has **no documented default**, so the metric is ambiguous unless set.
- **Fix / workaround:** Set `metric: "cosine"` explicitly at index creation; derive `similarity = 1 - distance`; compare on that.
- **Upstream:** Document the metric default and the distance semantics prominently.

## 6. 🟠 `query()` returns `metadata` but not `contents`
- **Symptom:** Source-card snippets were empty when read from query results.
- **Root cause:** `query()` returns `metadata` only; the chunk text (`contents`) is returned by `get()`, not `query()`.
- **Fix / workaround:** Store the snippet/text in `metadata` at upsert time so it comes back with the query (avoids a second `get()` round-trip per hit).

## 7. 🟠 SDK API drift between 0.15.0 and 0.17.0 — `getDimension()` vs `getIndexConfig()`
- **Symptom:** Code written against the documented `getDimension()` failed on the installed SDK.
- **Root cause:** `cyborgdb` **0.15.0** had no `getDimension()` (had to read `getIndexConfig().dimension`); **0.17.0** restored `getDimension(): Promise<number>` and dropped `getIndexConfig()`. The local source tree and the published npm differed too.
- **Fix / workaround:** Pin the SDK version and the `cyborgdb-service` image to the **same** version (we standardized on 0.17.0) and code to that surface.
- **Upstream:** Keep the published SDK, its types, and the docs in lockstep across versions.

## 8. 🟡 Embedding model is fetched from HuggingFace on first use (network dependency)
- **Symptom:** First-ever ingest triggered a HuggingFace download; an air-gapped host would fail.
- **Root cause:** The image doesn't bundle the default embedding model; it's pulled on demand.
- **Fix / workaround:** Ensure outbound network on first run, or pre-populate the HF cache volume; persist `/home/cyborguser/.cache/huggingface`.
- **Upstream:** Pre-bundle the default model (or document the offline-prep steps).

## 9. 🟡 Two similarly-named keys, both optional, easy to conflate
- **Symptom:** Spent time deciding whether an API key was required.
- **Root cause:** `CYBORGDB_API_KEY` (cyborgdb-core **license**; unset = free tier, 1M items/index) vs `CYBORGDB_SERVICE_ROOT_KEY` (**service auth**; unset = auth disabled). Both optional, similarly named.
- **Fix / workaround:** For local/self-hosted, set neither (free tier + auth disabled). The SDK client's `apiKey` maps to the service **root key**, not the license key.
- **Upstream:** Clearer naming / a single doc table (Docker Hub does have one, but it's easy to miss).

## 10b. 🟠 Disk mode silently stores data in the container layer with no volume — no warning
- **Symptom:** `cyborgdb-service` started with `CYBORGDB_DB_TYPE=disk` but no volume mounted at `CYBORGDB_DISK_PATH` runs fine and accepts writes — but all vector data lives in the container's writable layer and is **lost the moment the container is removed/recreated**, with no error or warning.
- **Root cause:** The service doesn't check whether its disk path is backed by a mount/volume; persistence "works" until the container is gone.
- **Impact:** A classic data-loss footgun — easy to `docker rm` (or `docker compose down -v`, or an image update) and silently wipe the index.
- **Fix / workaround:** Always mount a named volume at the disk path (now done — see Deployment notes). 
- **Upstream (requested):** In disk mode, the service should **log a clear warning at startup** when the disk path is not a mountpoint (e.g. "CYBORGDB_DISK_PATH is on the container's writable layer; mount a volume or data will be lost on container removal"). Erroring would be too strict (ephemeral/test runs are valid), but a warning is warranted.

## 10. 🟡 Docs discoverability
- **Symptom:** `cyborgdb.co/docs` 404s; the embedding-model configuration page wasn't in the `docs.cyborg.co/llms.txt` index.
- **Fix / workaround:** Real docs live at `docs.cyborg.co`; Docker Hub README is the most useful source for env vars.

---

## Deployment notes (knowledgeLLM specifics)
- The app's `docker-compose.yml` sets `CYBORGDB_DB_TYPE=disk` (standalone/RocksDB). Add `HF_HUB_OFFLINE=1` + `TRANSFORMERS_OFFLINE=1` and persist the HF cache volume for fast embedding (#1, #8).
- On the spark test box, `cyborgdb-service` was started via a bare `docker run` with **no data volume** and **no `--restart` policy** — vector data lives in the container's writable layer (lost if the container is removed; survives stop/start and reboots only if not pruned). Production should mount a data volume and an HF cache volume, and use `--restart unless-stopped`.
