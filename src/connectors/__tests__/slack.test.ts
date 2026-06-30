// Slack connector tests (U9 / R13). `fetch` is fully mocked with a router that
// dispatches by Slack Web API method and serves canned responses, so the
// connector's pagination, threading, author resolution, permalink, scope
// advisory, not-a-member handling, and 429 backoff are all exercised without a
// network. No Slack SDK or live token is involved.
//
// Coverage:
// - a channel → top-level messages + thread replies yielded as Chunks with
//   channel/author/ts/permalink metadata and chunkId-derived ids;
// - bot-not-member channel → listTargets flags it with a note (not a throw),
//   and sync of a not_in_channel channel yields 0 chunks (not a throw);
// - archived / empty channel → 0 chunks;
// - invalid token → validate ok:false;
// - excess scope → validate ok:true with scopeWarning;
// - 429 then success → retried, content still yielded.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { slackConnector } from "../slack.js";
import { chunkId } from "../chunk.js";

const CREDS = { token: "xoxb-test-token" };

// --- fetch mock plumbing ---------------------------------------------------

type Json = Record<string, unknown>;

interface CannedResponse {
  status?: number;
  headers?: Record<string, string>;
  body: Json;
}

// Method name (e.g. "conversations.history") → queue of responses. Each call
// shifts the next queued response; the last one sticks (so a single canned
// response serves repeated calls). A function value receives the request URL.
type Handler = CannedResponse | ((url: URL) => CannedResponse);
const handlers = new Map<string, Handler[]>();

function on(method: string, ...responses: Handler[]): void {
  handlers.set(method, responses);
}

function methodOf(url: URL): string {
  // .../api/<method>
  const path = url.pathname;
  return path.slice(path.lastIndexOf("/") + 1);
}

function makeResponse(canned: CannedResponse): Response {
  const status = canned.status ?? 200;
  const headers = new Headers(canned.headers ?? {});
  return {
    status,
    headers,
    json: async () => canned.body,
  } as unknown as Response;
}

const fetchMock = vi.fn(async (input: unknown) => {
  const url = input instanceof URL ? input : new URL(String(input));
  const method = methodOf(url);
  const queue = handlers.get(method);
  if (!queue || queue.length === 0) {
    throw new Error(`No mock handler for Slack method "${method}" (${url.href})`);
  }
  // Shift unless it's the last one (then it sticks for repeated calls).
  const entry = queue.length > 1 ? (queue.shift() as Handler) : queue[0] as Handler;
  const canned = typeof entry === "function" ? entry(url) : entry;
  return makeResponse(canned);
});

beforeEach(() => {
  handlers.clear();
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  // users.list is fetched once at the start of every sync; default to two users.
  on("users.list", {
    body: {
      ok: true,
      members: [
        { id: "U1", profile: { display_name: "alice" } },
        { id: "U2", profile: { real_name: "Bob Real" } },
      ],
    },
  });
  // permalink: serve a deterministic link for any message.
  on("chat.getPermalink", (url) => ({
    body: {
      ok: true,
      permalink: `https://acme.slack.com/archives/${url.searchParams.get("channel")}/p${(url.searchParams.get("message_ts") ?? "").replace(".", "")}`,
    },
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function collect(iter: AsyncIterable<unknown>): Promise<any[]> {
  const out: any[] = [];
  for await (const c of iter) out.push(c);
  return out;
}

// --- tests -----------------------------------------------------------------

describe("slackConnector.validate", () => {
  it("returns ok:false on an invalid token", async () => {
    on("auth.test", { body: { ok: false, error: "invalid_auth" } });
    const result = await slackConnector.validate(CREDS);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/invalid|revoked/i);
  });

  it("returns ok:false when the token is missing", async () => {
    const result = await slackConnector.validate({});
    expect(result.ok).toBe(false);
  });

  it("returns ok:true with no warning at exactly the minimum scope", async () => {
    on("auth.test", {
      headers: { "x-oauth-scopes": "channels:history,channels:read,users:read" },
      body: { ok: true, user: "knowledgebot" },
    });
    const result = await slackConnector.validate(CREDS);
    expect(result.ok).toBe(true);
    expect(result.scopeWarning).toBeUndefined();
  });

  it("warns (does not fail) on scope beyond the minimum", async () => {
    on("auth.test", {
      headers: {
        "x-oauth-scopes":
          "channels:history,channels:read,users:read,chat:write,files:read",
      },
      body: { ok: true },
    });
    const result = await slackConnector.validate(CREDS);
    expect(result.ok).toBe(true);
    expect(result.scopeWarning).toMatch(/chat:write/);
    expect(result.scopeWarning).toMatch(/files:read/);
  });
});

describe("slackConnector.listTargets", () => {
  it("lists public channels, flagging non-member channels with a note", async () => {
    on("conversations.list", {
      body: {
        ok: true,
        channels: [
          { id: "C1", name: "general", is_member: true },
          { id: "C2", name: "random", is_member: false },
          { id: "C3", name: "old", is_member: true, is_archived: true },
        ],
        response_metadata: { next_cursor: "" },
      },
    });

    const targets = await slackConnector.listTargets(CREDS);
    expect(targets).toHaveLength(3);

    const general = targets.find((t) => t.id === "C1");
    expect(general?.label).toBe("#general");
    expect(general?.note).toBeUndefined();

    const random = targets.find((t) => t.id === "C2");
    expect(random?.label).toBe("#random");
    // Surfaced distinctly: a note, NOT a throw or omission.
    expect(random?.note).toMatch(/not a member/i);

    const old = targets.find((t) => t.id === "C3");
    expect(old?.note).toMatch(/archived/i);
  });

  it("paginates via next_cursor", async () => {
    on(
      "conversations.list",
      {
        body: {
          ok: true,
          channels: [{ id: "C1", name: "one", is_member: true }],
          response_metadata: { next_cursor: "PAGE2" },
        },
      },
      {
        body: {
          ok: true,
          channels: [{ id: "C2", name: "two", is_member: true }],
          response_metadata: { next_cursor: "" },
        },
      },
    );

    const targets = await slackConnector.listTargets(CREDS);
    expect(targets.map((t) => t.id)).toEqual(["C1", "C2"]);
  });
});

describe("slackConnector.sync", () => {
  it("yields chunks for messages + thread replies with full metadata", async () => {
    on("conversations.history", {
      body: {
        ok: true,
        messages: [
          // A thread root with replies.
          { type: "message", ts: "100.000", thread_ts: "100.000", reply_count: 2, text: "How do we deploy?", user: "U1" },
          // A standalone message.
          { type: "message", ts: "90.000", text: "Standalone note", user: "U2" },
          // A join event — should be skipped.
          { type: "message", subtype: "channel_join", ts: "80.000", text: "joined", user: "U2" },
        ],
        response_metadata: { next_cursor: "" },
      },
    });
    on("conversations.replies", {
      body: {
        ok: true,
        messages: [
          { type: "message", ts: "100.000", thread_ts: "100.000", reply_count: 2, text: "How do we deploy?", user: "U1" },
          { type: "message", ts: "101.000", thread_ts: "100.000", text: "Run the deploy script", user: "U2" },
          { type: "message", ts: "102.000", thread_ts: "100.000", text: "Thanks!", user: "U1" },
        ],
        response_metadata: { next_cursor: "" },
      },
    });

    const chunks = await collect(slackConnector.sync(CREDS, ["C1"]));

    // One chunk per source unit (small bodies fit in one window): thread + standalone.
    expect(chunks).toHaveLength(2);

    const thread = chunks.find((c) => c.metadata.ref === "100.000");
    expect(thread).toBeDefined();
    // chunk id is the KTD7 hash for (slack, channel, threadRoot, 0).
    expect(thread.id).toBe(chunkId("slack", "C1", "100.000", 0));
    // Thread groups root + replies together (KTD8a), with resolved author names.
    expect(thread.contents).toContain("alice: How do we deploy?");
    expect(thread.contents).toContain("Bob Real: Run the deploy script");
    expect(thread.contents).toContain("alice: Thanks!");
    // Mandatory + connector metadata.
    expect(thread.metadata.connector).toBe("slack");
    expect(thread.metadata.target).toBe("C1");
    expect(thread.metadata.channel).toBe("C1");
    expect(thread.metadata.author).toBe("alice");
    expect(thread.metadata.ts).toBe("100.000");
    expect(thread.metadata.title).toContain("alice");
    expect(thread.metadata.snippet).toBe(thread.contents);
    expect(thread.metadata.permalink).toMatch(/archives\/C1\/p100000/);

    const standalone = chunks.find((c) => c.metadata.ref === "90.000");
    expect(standalone).toBeDefined();
    expect(standalone.id).toBe(chunkId("slack", "C1", "90.000", 0));
    expect(standalone.contents).toContain("Bob Real: Standalone note");
    // No replies were fetched for the standalone message.
  });

  it("resolves a channel name (not an ID) to its ID via conversations.list", async () => {
    on("conversations.list", {
      body: {
        ok: true,
        channels: [
          { id: "C9", name: "engineering", is_member: true },
          { id: "C8", name: "random", is_member: true },
        ],
        response_metadata: { next_cursor: "" },
      },
    });
    on("conversations.history", {
      body: {
        ok: true,
        messages: [{ type: "message", ts: "90.000", text: "Hello eng", user: "U1" }],
        response_metadata: { next_cursor: "" },
      },
    });

    const chunks = await collect(slackConnector.sync(CREDS, ["engineering"]));
    expect(chunks).toHaveLength(1);
    // The resolved channel ID (C9), not the name, flows into chunk metadata.
    expect(chunks[0].metadata.channel).toBe("C9");
  });

  it("throws a clear error for a channel name that matches no public channel", async () => {
    on("conversations.list", {
      body: {
        ok: true,
        channels: [{ id: "C9", name: "engineering", is_member: true }],
        response_metadata: { next_cursor: "" },
      },
    });
    await expect(collect(slackConnector.sync(CREDS, ["nope"]))).rejects.toThrow(/not found/i);
  });

  it("yields 0 chunks for a channel the bot is not a member of (no throw)", async () => {
    on("conversations.history", { body: { ok: false, error: "not_in_channel" } });

    // Should not throw; should simply yield nothing for that channel.
    const chunks = await collect(slackConnector.sync(CREDS, ["C2"]));
    expect(chunks).toHaveLength(0);
  });

  it("yields 0 chunks for an empty / archived channel", async () => {
    on("conversations.history", {
      body: { ok: true, messages: [], response_metadata: { next_cursor: "" } },
    });
    const empty = await collect(slackConnector.sync(CREDS, ["C3"]));
    expect(empty).toHaveLength(0);

    on("conversations.history", { body: { ok: false, error: "is_archived" } });
    const archived = await collect(slackConnector.sync(CREDS, ["C3"]));
    expect(archived).toHaveLength(0);
  });

  it("honors a 429 Retry-After then succeeds", async () => {
    // First conversations.history call 429s, then the retry returns content.
    on(
      "conversations.history",
      { status: 429, headers: { "retry-after": "0" }, body: { ok: false, error: "ratelimited" } },
      {
        body: {
          ok: true,
          messages: [{ type: "message", ts: "200.000", text: "after backoff", user: "U1" }],
          response_metadata: { next_cursor: "" },
        },
      },
    );

    const chunks = await collect(slackConnector.sync(CREDS, ["C1"]));
    expect(chunks).toHaveLength(1);
    expect(chunks[0].contents).toContain("after backoff");
    // The 429 plus the successful retry = two fetches to conversations.history.
    const historyCalls = fetchMock.mock.calls.filter(([u]) =>
      String((u as URL).href).includes("conversations.history"),
    );
    expect(historyCalls.length).toBe(2);
  });

  it("paginates conversations.history via next_cursor", async () => {
    on(
      "conversations.history",
      {
        body: {
          ok: true,
          messages: [{ type: "message", ts: "1.000", text: "page one", user: "U1" }],
          response_metadata: { next_cursor: "CURSOR2" },
        },
      },
      {
        body: {
          ok: true,
          messages: [{ type: "message", ts: "2.000", text: "page two", user: "U2" }],
          response_metadata: { next_cursor: "" },
        },
      },
    );

    const chunks = await collect(slackConnector.sync(CREDS, ["C1"]));
    expect(chunks).toHaveLength(2);
    expect(chunks.map((c) => c.metadata.ref).sort()).toEqual(["1.000", "2.000"]);
  });
});
