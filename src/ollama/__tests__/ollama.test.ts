import { afterEach, describe, expect, it, vi } from "vitest";
import {
  validateOllamaUrl,
  testConnection,
  streamChat,
} from "../client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A fetch stub for the testConnection two-call sequence (GET / then /api/tags). */
function mockTagsFetch(tagsResponse: {
  status?: number;
  body?: unknown;
  ok?: boolean;
}) {
  return vi.fn(async (input: string | URL | Request) => {
    const u = String(input);
    if (u.endsWith("/")) {
      return new Response("Ollama is running", { status: 200 });
    }
    if (u.endsWith("/api/tags")) {
      const status = tagsResponse.status ?? 200;
      return new Response(JSON.stringify(tagsResponse.body ?? {}), {
        status,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch ${u}`);
  });
}

/** Build a ReadableStream<Uint8Array> from a list of string chunks. */
function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(enc.encode(chunks[i++]));
      } else {
        controller.close();
      }
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// SSRF guard (R29)
// ---------------------------------------------------------------------------

describe("validateOllamaUrl (SSRF guard)", () => {
  it("rejects the cloud metadata IP", () => {
    const r = validateOllamaUrl("http://169.254.169.254");
    expect(r.ok).toBe(false);
  });

  it("rejects private/link-local ranges", () => {
    expect(validateOllamaUrl("http://10.0.0.5:11434").ok).toBe(false);
    expect(validateOllamaUrl("http://172.16.5.4").ok).toBe(false);
    expect(validateOllamaUrl("http://192.168.1.50:11434").ok).toBe(false);
    expect(validateOllamaUrl("http://169.254.10.10").ok).toBe(false);
  });

  it("rejects encoded numeric IPs (decimal / hex / octal) that decode to private/metadata", () => {
    // 167772165 === 10.0.0.5 (private), 0xa000005 === 10.0.0.5, octal too.
    expect(validateOllamaUrl("http://167772165").ok).toBe(false);
    expect(validateOllamaUrl("http://0xa000005").ok).toBe(false);
    expect(validateOllamaUrl("http://3232235826").ok).toBe(false); // 192.168.1.50
    // 2852039166 === 169.254.169.254 (the metadata IP) — always blocked.
    expect(validateOllamaUrl("http://2852039166").ok).toBe(false);
  });

  it("rejects IPv4-mapped IPv6 pointing at the metadata IP", () => {
    expect(validateOllamaUrl("http://[::ffff:169.254.169.254]").ok).toBe(false);
  });

  it("rejects non-http(s) schemes", () => {
    expect(validateOllamaUrl("file:///etc/passwd").ok).toBe(false);
    expect(validateOllamaUrl("ftp://example.com").ok).toBe(false);
    expect(validateOllamaUrl("gopher://example.com").ok).toBe(false);
  });

  it("allows loopback for self-hosted local Ollama", () => {
    expect(validateOllamaUrl("http://localhost:11434").ok).toBe(true);
    expect(validateOllamaUrl("http://127.0.0.1:11434").ok).toBe(true);
  });

  it("allows a normal remote host and normalizes to origin", () => {
    const r = validateOllamaUrl("http://ollama.example.com:11434/some/path");
    expect(r.ok).toBe(true);
    expect(r.url).toBe("http://ollama.example.com:11434");
  });

  it("rejects empty/garbage input", () => {
    expect(validateOllamaUrl("").ok).toBe(false);
    expect(validateOllamaUrl("not a url").ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// testConnection — model discovery + classification (KTD6)
// ---------------------------------------------------------------------------

describe("testConnection", () => {
  it("rejects an SSRF-range URL before any fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const r = await testConnection("http://169.254.169.254");
    expect(r.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("surfaces chat models and flags ambiguous (no-family) ones without hiding them", async () => {
    const fetchSpy = mockTagsFetch({
      body: {
        models: [
          { name: "llama3:8b", details: { family: "llama" } },
          { name: "nomic-embed-text", details: { family: "nomic-bert" } },
          { name: "mxbai-embed", details: { family: "bert" } },
          { name: "mystery-model", details: {} }, // ambiguous: no family
        ],
      },
    });
    vi.stubGlobal("fetch", fetchSpy);

    const r = await testConnection("http://localhost:11434");
    expect(r.ok).toBe(true);
    const names = r.chatModels.map((m) => m.name);
    // Embedding models filtered out.
    expect(names).toContain("llama3:8b");
    expect(names).toContain("mystery-model");
    expect(names).not.toContain("nomic-embed-text");
    expect(names).not.toContain("mxbai-embed");
    // Ambiguous model surfaced but flagged.
    const llama = r.chatModels.find((m) => m.name === "llama3:8b");
    const mystery = r.chatModels.find((m) => m.name === "mystery-model");
    expect(llama?.flaggedMaybeEmbedding).toBe(false);
    expect(mystery?.flaggedMaybeEmbedding).toBe(true);
  });

  it("classifies an empty model list as reachable-no-models", async () => {
    vi.stubGlobal("fetch", mockTagsFetch({ body: { models: [] } }));
    const r = await testConnection("http://localhost:11434");
    expect(r.ok).toBe(true);
    expect(r.chatModels).toHaveLength(0);
    expect(r.message).toMatch(/ollama pull/i);
  });

  it("classifies connection refused distinctly", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const err = new Error("fetch failed");
        (err as { cause?: unknown }).cause = { code: "ECONNREFUSED" };
        throw err;
      }),
    );
    const r = await testConnection("http://localhost:11434");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/refused/i);
  });

  it("classifies DNS failure distinctly", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const err = new Error("getaddrinfo ENOTFOUND nope.invalid");
        (err as { cause?: unknown }).cause = { code: "ENOTFOUND" };
        throw err;
      }),
    );
    const r = await testConnection("http://nope.invalid:11434");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/dns|resolve/i);
  });

  it("classifies a timeout (AbortError) distinctly", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input, init?: RequestInit) => {
        // Simulate the abort firing.
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }),
    );
    const r = await testConnection("http://localhost:11434", { timeoutMs: 10 });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/timed out/i);
  });

  it("classifies a /api/tags 404 distinctly (not an Ollama server)", async () => {
    vi.stubGlobal("fetch", mockTagsFetch({ status: 404 }));
    const r = await testConnection("http://localhost:11434");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/404/);
  });

  it("refuses to follow a redirect (3xx) from the host (SSRF — R29)", async () => {
    // The liveness GET / returns a 302 (e.g. pointing at a private/metadata
    // host). With redirect:"manual" we see the 3xx and must treat it as failure
    // rather than follow it.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } })),
    );
    const r = await testConnection("http://localhost:11434");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/redirect/i);
  });
});

// ---------------------------------------------------------------------------
// streamChat — NDJSON buffering + cancellation (KTD6, R27)
// ---------------------------------------------------------------------------

describe("streamChat", () => {
  it("yields tokens then stops on done:true", async () => {
    const chunks = [
      JSON.stringify({ message: { content: "Hello" }, done: false }) + "\n",
      JSON.stringify({ message: { content: " world" }, done: false }) + "\n",
      JSON.stringify({ message: { content: "" }, done: true }) + "\n",
      // A frame after done must never be yielded.
      JSON.stringify({ message: { content: "AFTER" }, done: false }) + "\n",
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(streamFromChunks(chunks), { status: 200 })),
    );

    const out: string[] = [];
    for await (const t of streamChat({
      url: "http://localhost:11434",
      model: "llama3",
      messages: [{ role: "user", content: "hi" }],
    })) {
      out.push(t);
    }
    expect(out.join("")).toBe("Hello world");
    expect(out).not.toContain("AFTER");
  });

  it("reassembles an NDJSON line split across reads", async () => {
    const full =
      JSON.stringify({ message: { content: "split-token" }, done: false }) + "\n";
    const mid = Math.floor(full.length / 2);
    // The first read ends mid-JSON; the second completes the line.
    const chunks = [
      full.slice(0, mid),
      full.slice(mid),
      JSON.stringify({ message: { content: "" }, done: true }) + "\n",
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(streamFromChunks(chunks), { status: 200 })),
    );

    const out: string[] = [];
    for await (const t of streamChat({
      url: "http://localhost:11434",
      model: "llama3",
      messages: [{ role: "user", content: "hi" }],
    })) {
      out.push(t);
    }
    expect(out.join("")).toBe("split-token");
  });

  it("handles multiple frames arriving in one read", async () => {
    const chunks = [
      JSON.stringify({ message: { content: "a" }, done: false }) +
        "\n" +
        JSON.stringify({ message: { content: "b" }, done: false }) +
        "\n",
      JSON.stringify({ message: { content: "" }, done: true }) + "\n",
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(streamFromChunks(chunks), { status: 200 })),
    );

    const out: string[] = [];
    for await (const t of streamChat({
      url: "http://localhost:11434",
      model: "llama3",
      messages: [{ role: "user", content: "hi" }],
    })) {
      out.push(t);
    }
    expect(out.join("")).toBe("ab");
  });

  it("aborts the upstream fetch when the signal fires", async () => {
    const controller = new AbortController();
    const enc = new TextEncoder();
    let pulled = false;

    // Build a body whose pull rejects when the fetch's signal aborts — this is
    // what native fetch does to its body stream on abort. We wire it in the
    // fetch stub below where the per-request signal is available.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input, init?: RequestInit) => {
        const signal = init?.signal;
        const body = new ReadableStream<Uint8Array>({
          pull(streamController) {
            if (!pulled) {
              pulled = true;
              streamController.enqueue(
                enc.encode(
                  JSON.stringify({ message: { content: "tok" }, done: false }) +
                    "\n",
                ),
              );
              return;
            }
            // After the first token, hang until the signal aborts the body.
            return new Promise<void>((_resolve, reject) => {
              if (signal?.aborted) {
                reject(new DOMException("aborted", "AbortError"));
                return;
              }
              signal?.addEventListener(
                "abort",
                () => {
                  streamController.error(new DOMException("aborted", "AbortError"));
                  reject(new DOMException("aborted", "AbortError"));
                },
                { once: true },
              );
            });
          },
        });
        return new Response(body, { status: 200 });
      }),
    );

    const out: string[] = [];
    let threw = false;
    try {
      for await (const t of streamChat({
        url: "http://localhost:11434",
        model: "llama3",
        messages: [{ role: "user", content: "hi" }],
        signal: controller.signal,
        inactivityTimeoutMs: 50_000,
      })) {
        out.push(t);
        // Abort right after the first token.
        controller.abort();
      }
    } catch {
      threw = true;
    }
    expect(out).toEqual(["tok"]);
    // The loop must terminate (either cleanly or by throwing) once aborted.
    expect(threw || out.length === 1).toBe(true);
  });

  it("aborts via the inactivity timeout backstop when no data arrives", async () => {
    // A body that never emits anything until the fetch signal aborts it.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input, init?: RequestInit) => {
        const signal = init?.signal;
        const body = new ReadableStream<Uint8Array>({
          pull() {
            return new Promise<void>((_resolve, reject) => {
              if (signal?.aborted) {
                reject(new DOMException("aborted", "AbortError"));
                return;
              }
              signal?.addEventListener(
                "abort",
                () => reject(new DOMException("aborted", "AbortError")),
                { once: true },
              );
            });
          },
        });
        return new Response(body, { status: 200 });
      }),
    );

    const start = Date.now();
    let threw = false;
    try {
      for await (const _t of streamChat({
        url: "http://localhost:11434",
        model: "llama3",
        messages: [{ role: "user", content: "hi" }],
        inactivityTimeoutMs: 50,
      })) {
        // no-op
      }
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(Date.now() - start).toBeLessThan(5000);
  });

  it("rejects an SSRF-range URL before fetching", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(async () => {
      for await (const _t of streamChat({
        url: "http://169.254.169.254",
        model: "llama3",
        messages: [{ role: "user", content: "hi" }],
      })) {
        // no-op
      }
    }).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
