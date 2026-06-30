import { afterEach, describe, expect, it, vi } from "vitest";
import { githubConnector } from "../github.js";
import type { Chunk } from "../types.js";

// --- fetch mocking ---------------------------------------------------------

type Handler = (url: string) => { status?: number; headers?: Record<string, string>; body?: unknown };

let handlers: Handler[] = [];

function mockFetch() {
  return vi.fn(async (input: string | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    for (const h of handlers) {
      const r = h(url);
      if (r) {
        const headers = new Headers(r.headers ?? {});
        return {
          ok: (r.status ?? 200) >= 200 && (r.status ?? 200) < 300,
          status: r.status ?? 200,
          headers,
          json: async () => r.body,
          text: async () => JSON.stringify(r.body ?? ""),
        } as unknown as Response;
      }
    }
    throw new Error(`unhandled fetch: ${url}`);
  });
}

async function collect(iter: AsyncIterable<Chunk>): Promise<Chunk[]> {
  const out: Chunk[] = [];
  for await (const c of iter) out.push(c);
  return out;
}

afterEach(() => {
  handlers = [];
  vi.restoreAllMocks();
});

const TOKEN = { token: "ghp_test" };

describe("githubConnector.validate", () => {
  it("returns ok:false on a 401", async () => {
    vi.stubGlobal("fetch", mockFetch());
    handlers = [(u) => (u.endsWith("/user") ? { status: 401, body: {} } : null!)];
    const r = await githubConnector.validate(TOKEN);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/401|invalid/i);
  });

  it("warns (does not fail) on excess scope", async () => {
    vi.stubGlobal("fetch", mockFetch());
    handlers = [
      (u) =>
        u.endsWith("/user")
          ? { status: 200, headers: { "x-oauth-scopes": "repo, delete_repo, admin:org" }, body: { login: "x" } }
          : null!,
    ];
    const r = await githubConnector.validate(TOKEN);
    expect(r.ok).toBe(true);
    expect(r.scopeWarning).toMatch(/broader scope|delete_repo|admin:org/i);
  });

  it("accepts a minimal token with no warning", async () => {
    vi.stubGlobal("fetch", mockFetch());
    handlers = [
      (u) => (u.endsWith("/user") ? { status: 200, headers: { "x-oauth-scopes": "repo" }, body: { login: "x" } } : null!),
    ];
    const r = await githubConnector.validate(TOKEN);
    expect(r.ok).toBe(true);
    expect(r.scopeWarning).toBeUndefined();
  });

  it("accepts a raw token string (the shape the API layer stores/passes)", async () => {
    vi.stubGlobal("fetch", mockFetch());
    handlers = [
      (u) => (u.endsWith("/user") ? { status: 200, headers: { "x-oauth-scopes": "repo" }, body: { login: "x" } } : null!),
    ];
    const r = await githubConnector.validate("ghp_test");
    expect(r.ok).toBe(true);
  });

  it("returns ok:false (not a throw) on an empty credential", async () => {
    const r = await githubConnector.validate("");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/non-empty|token/i);
  });
});

describe("githubConnector.sync", () => {
  function repoTree(entries: Array<{ path: string; size?: number; sha?: string }>) {
    return {
      tree: entries.map((e) => ({ path: e.path, type: "blob", size: e.size ?? 10, sha: e.sha ?? `sha-${e.path}` })),
      truncated: false,
    };
  }

  it("ingests files (code + docs) and issues, excludes PRs (AE4)", async () => {
    vi.stubGlobal("fetch", mockFetch());
    handlers = [
      (u) =>
        /\/repos\/me\/repo$/.test(u) ? { body: { full_name: "me/repo", default_branch: "main" } } : null!,
      (u) =>
        u.includes("/git/trees/main")
          ? { body: repoTree([{ path: "src/app.ts" }, { path: "README.md" }, { path: "logo.png" }]) }
          : null!,
      (u) =>
        u.includes("/git/blobs/")
          ? { body: { content: Buffer.from("hello world content").toString("base64"), encoding: "base64" } }
          : null!,
      (u) =>
        u.includes("/issues?state=all")
          ? {
              body: [
                { number: 1, title: "A bug", body: "broken", html_url: "https://gh/1", comments: 0 },
                { number: 2, title: "A PR", body: "diff", html_url: "https://gh/2", comments: 0, pull_request: { url: "x" } },
              ],
            }
          : null!,
    ];

    const chunks = await collect(githubConnector.sync(TOKEN, ["me/repo"]));
    const refs = chunks.map((c) => c.metadata.ref);

    // files: app.ts + README.md ingested, logo.png skipped (binary)
    expect(refs).toContain("src/app.ts");
    expect(refs).toContain("README.md");
    expect(refs.some((r) => String(r).includes("logo.png"))).toBe(false);
    // issue #1 present, PR #2 excluded (AE4)
    expect(refs).toContain("issue/1");
    expect(refs).not.toContain("issue/2");
    // metadata shape + chunkId-derived id
    for (const c of chunks) {
      expect(c.metadata).toMatchObject({ connector: "github", target: "me/repo" });
      expect(c.metadata.snippet).toBeTruthy();
      expect(c.metadata.title).toBeTruthy();
      expect(c.id).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("treats an empty repo (409 tree) as zero file chunks, no error", async () => {
    vi.stubGlobal("fetch", mockFetch());
    handlers = [
      (u) => (/\/repos\/me\/empty$/.test(u) ? { body: { full_name: "me/empty", default_branch: "main" } } : null!),
      (u) => (u.includes("/git/trees/main") ? { status: 409, body: {} } : null!),
      (u) => (u.includes("/issues?state=all") ? { body: [] } : null!),
    ];
    const chunks = await collect(githubConnector.sync(TOKEN, ["me/empty"]));
    expect(chunks).toHaveLength(0);
  });

  it("accepts a pasted GitHub URL as a target (normalizes to owner/repo)", async () => {
    vi.stubGlobal("fetch", mockFetch());
    handlers = [
      (u) => (/\/repos\/me\/repo$/.test(u) ? { body: { full_name: "me/repo", default_branch: "main" } } : null!),
      (u) => (u.includes("/git/trees/main") ? { body: repoTree([{ path: "README.md" }]) } : null!),
      (u) =>
        u.includes("/git/blobs/")
          ? { body: { content: Buffer.from("hi").toString("base64"), encoding: "base64" } }
          : null!,
      (u) => (u.includes("/issues?state=all") ? { body: [] } : null!),
    ];
    const chunks = await collect(githubConnector.sync(TOKEN, ["https://github.com/me/repo"]));
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.map((c) => c.metadata.ref)).toContain("README.md");
  });

  it("retries on 429 then succeeds", async () => {
    vi.stubGlobal("fetch", mockFetch());
    let userHits = 0;
    handlers = [
      (u) => {
        if (!u.endsWith("/user")) return null!;
        userHits += 1;
        return userHits === 1
          ? { status: 429, headers: { "retry-after": "0" }, body: {} }
          : { status: 200, headers: { "x-oauth-scopes": "repo" }, body: { login: "x" } };
      },
    ];
    const r = await githubConnector.validate(TOKEN);
    expect(r.ok).toBe(true);
    expect(userHits).toBe(2);
  });
});
