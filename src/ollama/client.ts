// Ollama wrapper: SSRF-guarded connection test with model discovery, and a
// streaming chat call relaying Ollama's NDJSON. See KTD6 (connection test =
// GET / liveness + GET /api/tags discovery; chat models filtered from
// embedding models by details.family), R29 (SSRF guard), R27 (cancellation +
// server-side stream timeout).

// ---------------------------------------------------------------------------
// SSRF guard (R29)
// ---------------------------------------------------------------------------

export interface UrlValidation {
  ok: boolean;
  // The normalized origin (scheme + host + port) when ok. Use this for fetches.
  url?: string;
  reason?: string;
}

// Cloud metadata endpoints are blocked unconditionally — they are the classic
// SSRF target and never a legitimate Ollama host.
const ALWAYS_BLOCKED_HOSTS = new Set([
  "169.254.169.254", // AWS/GCP/Azure IMDS
  "metadata.google.internal",
  "[fd00:ec2::254]",
  "fd00:ec2::254",
]);

// Loopback / localhost is intentionally allowed: self-hosted users legitimately
// point at a locally-running Ollama. NOTE (Docker caveat): inside a container
// `localhost`/`127.0.0.1` resolves to the container itself, not the host —
// users on Docker must use `host.docker.internal` (or the host LAN IP). This is
// documented in .env.example / the setup wizard.
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function isLocalLoopback(hostname: string): boolean {
  if (LOCAL_HOSTNAMES.has(hostname)) return true;
  // 127.0.0.0/8 — entire loopback block.
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  return false;
}

// Private / link-local IPv4 ranges that should be rejected for a user-supplied
// remote URL (other than the explicitly-allowed loopback above). Returns the
// matched range name, or null if the host is not a blocked private address.
function matchPrivateRange(hostname: string): string | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!m) return null;
  const o = m.slice(1, 5).map(Number);
  if (o.some((n) => n > 255)) return null; // not a valid dotted-quad; treat as hostname
  const [a, b] = o;
  if (a === 10) return "10.0.0.0/8 (private)";
  if (a === 172 && b >= 16 && b <= 31) return "172.16.0.0/12 (private)";
  if (a === 192 && b === 168) return "192.168.0.0/16 (private)";
  if (a === 169 && b === 254) return "169.254.0.0/16 (link-local)";
  if (a === 0) return "0.0.0.0/8 (reserved)";
  return null;
}

// IPv6 private / link-local detection (best-effort, on the bracketed form
// stripped of brackets). loopback ::1 is handled by isLocalLoopback.
function matchPrivateRangeV6(hostname: string): string | null {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!h.includes(":")) return null;
  if (h.startsWith("fe80")) return "fe80::/10 (link-local)";
  if (h.startsWith("fc") || h.startsWith("fd")) return "fc00::/7 (unique-local)";
  return null;
}

/**
 * Validate a user-supplied Ollama base URL before any server-side fetch.
 * Rejects non-http(s) schemes and private/link-local/metadata ranges, while
 * allowing loopback for self-hosted local Ollama. Returns a typed result with a
 * normalized origin URL on success.
 */
export function validateOllamaUrl(input: string): UrlValidation {
  const raw = (input ?? "").trim();
  if (raw.length === 0) {
    return { ok: false, reason: "A URL is required." };
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: "Not a valid URL." };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      reason: `Unsupported scheme "${parsed.protocol}". Use http or https.`,
    };
  }

  const hostname = parsed.hostname.toLowerCase();

  if (ALWAYS_BLOCKED_HOSTS.has(hostname)) {
    return {
      ok: false,
      reason: "This address points at a cloud metadata endpoint and is blocked.",
    };
  }

  // Loopback is allowed (with the documented Docker caveat).
  if (!isLocalLoopback(hostname)) {
    const v4 = matchPrivateRange(hostname);
    if (v4) {
      return {
        ok: false,
        reason: `Refusing to connect to a private/link-local address (${v4}).`,
      };
    }
    const v6 = matchPrivateRangeV6(hostname);
    if (v6) {
      return {
        ok: false,
        reason: `Refusing to connect to a private/link-local address (${v6}).`,
      };
    }
  }

  // Normalize to scheme://host[:port] — drop any path/query a user may have
  // pasted so endpoint paths are appended cleanly.
  const port = parsed.port ? `:${parsed.port}` : "";
  const normalized = `${parsed.protocol}//${parsed.hostname}${port}`;
  return { ok: true, url: normalized };
}

// ---------------------------------------------------------------------------
// Connection test + model discovery (KTD6)
// ---------------------------------------------------------------------------

export interface ChatModelInfo {
  name: string;
  // True when the model's family looks like an embedding model but we are not
  // certain — surfaced flagged rather than hidden so an ambiguous model never
  // blocks the user from finishing setup.
  flaggedMaybeEmbedding: boolean;
}

export interface ConnectionResult {
  ok: boolean;
  version?: string;
  chatModels: ChatModelInfo[];
  // A human-facing classification message (refused / DNS / TLS / timeout /
  // tags-404 / reachable-no-models / ok-with-models).
  message: string;
}

interface OllamaTagModel {
  name?: string;
  model?: string;
  details?: { family?: string; families?: string[] | null };
}

// Families that strongly indicate an embedding-only model. We hide a model only
// when we are confident; anything ambiguous is flagged, not hidden.
const EMBEDDING_FAMILY_HINTS = ["bert", "nomic"];

function classifyFamily(
  families: string[],
): { isEmbedding: boolean; ambiguous: boolean } {
  if (families.length === 0) {
    // Unknown family — could be either. Flag as ambiguous.
    return { isEmbedding: false, ambiguous: true };
  }
  const hit = families.some((f) =>
    EMBEDDING_FAMILY_HINTS.some((hint) => f.toLowerCase().includes(hint)),
  );
  return { isEmbedding: hit, ambiguous: false };
}

/** Map a thrown fetch error to a distinct, human-facing classification. */
function classifyFetchError(err: unknown): string {
  // AbortError from our timeout controller.
  if (err instanceof Error && err.name === "AbortError") {
    return "Connection timed out — the host did not respond in time.";
  }
  // Node fetch wraps the underlying cause; inspect both.
  const cause = (err as { cause?: unknown })?.cause;
  const code =
    (cause as { code?: string })?.code ??
    (err as { code?: string })?.code ??
    "";
  const msg = err instanceof Error ? err.message : String(err);

  if (code === "ECONNREFUSED" || /ECONNREFUSED/.test(msg)) {
    return "Connection refused — nothing is listening at that address/port.";
  }
  if (
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    /ENOTFOUND|getaddrinfo|EAI_AGAIN/.test(msg)
  ) {
    return "DNS lookup failed — the hostname could not be resolved.";
  }
  if (
    /certificate|TLS|SSL|self[- ]signed|ERR_TLS|DEPTH_ZERO/i.test(msg) ||
    (typeof code === "string" && code.startsWith("ERR_TLS")) ||
    code === "CERT_HAS_EXPIRED" ||
    code === "DEPTH_ZERO_SELF_SIGNED_CERT"
  ) {
    return "TLS error — the server's certificate could not be verified.";
  }
  if (code === "ETIMEDOUT" || /timed? ?out|ETIMEDOUT/i.test(msg)) {
    return "Connection timed out — the host did not respond in time.";
  }
  return `Could not reach Ollama: ${msg}`;
}

const DEFAULT_TEST_TIMEOUT_MS = 5_000;

/**
 * Test reachability of an Ollama host and discover its chat models. SSRF-guards
 * the URL first, then probes `GET /` (liveness) and `GET /api/tags`
 * (discovery). Failures are classified into distinct messages.
 */
export async function testConnection(
  url: string,
  opts: { timeoutMs?: number } = {},
): Promise<ConnectionResult> {
  const guard = validateOllamaUrl(url);
  if (!guard.ok || !guard.url) {
    return { ok: false, chatModels: [], message: guard.reason ?? "Invalid URL." };
  }
  const base = guard.url;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS;

  // --- Liveness: GET / ---
  let version: string | undefined;
  const liveController = new AbortController();
  const liveTimer = setTimeout(() => liveController.abort(), timeoutMs);
  try {
    const res = await fetch(base + "/", { signal: liveController.signal });
    // Ollama's root returns "Ollama is running". A 2xx (or even a 404 from a
    // reachable proxy) proves we connected; the tags probe below decides the
    // model story. Capture a version header if present.
    version = res.headers.get("ollama-version") ?? undefined;
  } catch (err) {
    clearTimeout(liveTimer);
    return { ok: false, chatModels: [], message: classifyFetchError(err) };
  } finally {
    clearTimeout(liveTimer);
  }

  // --- Discovery: GET /api/tags ---
  const tagsController = new AbortController();
  const tagsTimer = setTimeout(() => tagsController.abort(), timeoutMs);
  let tagsRes: Response;
  try {
    tagsRes = await fetch(base + "/api/tags", { signal: tagsController.signal });
  } catch (err) {
    clearTimeout(tagsTimer);
    return { ok: false, chatModels: [], message: classifyFetchError(err) };
  } finally {
    clearTimeout(tagsTimer);
  }

  if (tagsRes.status === 404) {
    return {
      ok: false,
      version,
      chatModels: [],
      message:
        "Reached the host but /api/tags returned 404 — this does not look like an Ollama server.",
    };
  }
  if (!tagsRes.ok) {
    return {
      ok: false,
      version,
      chatModels: [],
      message: `Ollama responded with an unexpected status (${tagsRes.status}).`,
    };
  }

  let body: { models?: OllamaTagModel[] };
  try {
    body = (await tagsRes.json()) as { models?: OllamaTagModel[] };
  } catch {
    return {
      ok: false,
      version,
      chatModels: [],
      message: "Reached /api/tags but the response was not valid JSON.",
    };
  }

  const models = Array.isArray(body.models) ? body.models : [];

  if (models.length === 0) {
    return {
      ok: true,
      version,
      chatModels: [],
      message: "Connected, but no models are installed — run `ollama pull <model>`.",
    };
  }

  const chatModels: ChatModelInfo[] = [];
  for (const m of models) {
    const name = m.name ?? m.model;
    if (!name) continue;
    const families = [
      ...(m.details?.family ? [m.details.family] : []),
      ...(Array.isArray(m.details?.families) ? m.details!.families! : []),
    ].filter((f): f is string => typeof f === "string" && f.length > 0);

    const { isEmbedding, ambiguous } = classifyFamily(families);
    // Confidently-embedding models are hidden from the chat picker.
    if (isEmbedding) continue;
    chatModels.push({ name, flaggedMaybeEmbedding: ambiguous });
  }

  if (chatModels.length === 0) {
    return {
      ok: true,
      version,
      chatModels: [],
      message:
        "Connected, but only embedding models were found — install a chat model with `ollama pull <model>`.",
    };
  }

  return {
    ok: true,
    version,
    chatModels,
    message: `Connected — ${chatModels.length} chat model${chatModels.length === 1 ? "" : "s"} available.`,
  };
}

// ---------------------------------------------------------------------------
// Streaming chat (KTD6, R27)
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface StreamChatOptions {
  url: string;
  model: string;
  messages: ChatMessage[];
  numCtx?: number;
  // Caller-supplied abort signal (e.g. wired to a client disconnect). Aborts the
  // upstream fetch.
  signal?: AbortSignal;
  // Server-side inactivity backstop (ms): if no NDJSON line arrives within this
  // window, the stream is aborted. Defaults to 60s.
  inactivityTimeoutMs?: number;
}

const DEFAULT_INACTIVITY_TIMEOUT_MS = 60_000;

/**
 * Stream a chat completion from Ollama's `/api/chat` (stream:true NDJSON),
 * yielding content tokens as they arrive. Stops on `done:true`. Honors the
 * caller's AbortSignal and a server-side inactivity timeout backstop (R27).
 *
 * Uses the partial-line buffer pattern: NDJSON lines can split across chunk
 * reads, so an incomplete trailing line is buffered until its newline arrives.
 */
export async function* streamChat(
  opts: StreamChatOptions,
): AsyncGenerator<string, void, unknown> {
  const guard = validateOllamaUrl(opts.url);
  if (!guard.ok || !guard.url) {
    throw new Error(guard.reason ?? "Invalid Ollama URL.");
  }
  const base = guard.url;
  const inactivityMs = opts.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS;

  // Compose an internal controller so both the caller's signal and our
  // inactivity backstop can abort the same upstream fetch.
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort(opts.signal?.reason);
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort(opts.signal.reason);
    else opts.signal.addEventListener("abort", onCallerAbort, { once: true });
  }

  let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
  const armInactivity = () => {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      controller.abort(new Error("Ollama stream inactivity timeout"));
    }, inactivityMs);
  };

  const requestBody = {
    model: opts.model,
    messages: opts.messages,
    stream: true,
    ...(opts.numCtx ? { options: { num_ctx: opts.numCtx } } : {}),
  };

  try {
    armInactivity();
    const res = await fetch(base + "/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `Ollama /api/chat returned ${res.status}${detail ? `: ${detail}` : ""}`,
      );
    }
    if (!res.body) {
      throw new Error("Ollama /api/chat returned no response body.");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      armInactivity(); // reset backstop on every chunk

      buffer += decoder.decode(value, { stream: true });

      // Process complete lines; keep the trailing partial in the buffer.
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (line.length === 0) continue;

        let frame: {
          message?: { content?: string };
          done?: boolean;
          error?: string;
        };
        try {
          frame = JSON.parse(line);
        } catch {
          // Skip a malformed line rather than abort the whole stream.
          continue;
        }

        if (frame.error) {
          throw new Error(`Ollama error: ${frame.error}`);
        }
        const token = frame.message?.content;
        if (token) yield token;
        if (frame.done) return;
      }
    }

    // Flush any final buffered line that arrived without a trailing newline.
    const tail = buffer.trim();
    if (tail.length > 0) {
      try {
        const frame = JSON.parse(tail) as {
          message?: { content?: string };
          done?: boolean;
        };
        const token = frame.message?.content;
        if (token) yield token;
      } catch {
        // ignore a trailing partial that never completed
      }
    }
  } finally {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    if (opts.signal) opts.signal.removeEventListener("abort", onCallerAbort);
  }
}
