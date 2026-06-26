// Slack connector (U9 / R13 / KTD7 / KTD8a). Ingests selected public channels'
// messages + thread replies through the shared Connector contract (U7). Built
// fresh against the Slack Web API (https://slack.com/api/) over native fetch —
// no Slack SDK — with a bot token (xoxb-) sent as a Bearer credential.
//
// Grouping (KTD8a): a Slack conversation is chunked PER THREAD (root + replies
// together), never per message — one-size-fits-all per-message chunking destroys
// the conversational context retrieval needs. A standalone message (no replies)
// is its own one-message "thread".
//
// Security (R29): `validate` checks the token works and warns (does not fail) on
// scope beyond the minimum (channels:history, channels:read, users:read). DMs and
// private channels the bot is not invited to are out of scope. A channel the bot
// is not a member of is surfaced distinctly in listTargets and yields nothing in
// sync rather than throwing.

import { chunkId, chunkText } from "./chunk.js";
import { registerConnector } from "./registry.js";
import type { Chunk, Connector, ConnectorTarget, ValidationResult } from "./types.js";

const SLACK_API = "https://slack.com/api/";

// Minimum scopes this connector needs to do its job (R29). Excess scope warns.
const MIN_SCOPES = ["channels:history", "channels:read", "users:read"] as const;

// Cap on Retry-After backoff retries for a single request, so a hard-throttled
// workspace can't wedge a sync forever.
const MAX_RETRIES = 5;
// Fallback backoff (ms) when Slack 429s without a usable Retry-After header.
const DEFAULT_RETRY_MS = 1000;

/** Bot-token credentials. The token is an xoxb- bot token. */
export interface SlackCreds {
  token: string;
}

// Minimal shapes for the Slack API responses we read. Slack returns far more;
// we type only what we consume.
interface SlackResponse {
  ok: boolean;
  error?: string;
  response_metadata?: { next_cursor?: string };
}

interface SlackChannel {
  id: string;
  name: string;
  is_member?: boolean;
  is_archived?: boolean;
}

interface SlackMessage {
  type?: string;
  subtype?: string;
  ts: string;
  thread_ts?: string;
  reply_count?: number;
  text?: string;
  user?: string;
  bot_id?: string;
}

interface SlackUser {
  id: string;
  name?: string;
  deleted?: boolean;
  profile?: { display_name?: string; real_name?: string };
}

function asCreds(creds: unknown): SlackCreds {
  const token = (creds as { token?: unknown } | null)?.token;
  if (typeof token !== "string" || token.length === 0) {
    throw new SlackError("Missing Slack bot token.", "no_token");
  }
  return { token };
}

/** A typed Slack API error so callers can branch on `error` (e.g. not_authed). */
class SlackError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "SlackError";
    this.code = code;
  }
}

/**
 * Call a Slack Web API method, honoring 429 `Retry-After` with backoff. Returns
 * the parsed JSON body and the raw response (so callers can read headers such as
 * `x-oauth-scopes`). Throws SlackError on `ok:false`.
 *
 * GET with the token as a Bearer header; params go in the query string. Slack
 * accepts this for the read methods we use.
 */
async function slackCall<T extends SlackResponse>(
  token: string,
  method: string,
  params: Record<string, string | number | undefined> = {},
): Promise<{ body: T; res: Response }> {
  const url = new URL(method, SLACK_API);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }

  let attempt = 0;
  // Retry loop is bounded by MAX_RETRIES on 429 only.
  for (;;) {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(30_000),
    });

    if (res.status === 429 && attempt < MAX_RETRIES) {
      const retryAfter = res.headers.get("retry-after");
      const waitMs = retryAfter
        ? Math.min(Number(retryAfter) * 1000, 60_000)
        : DEFAULT_RETRY_MS * (attempt + 1);
      attempt += 1;
      await sleep(Number.isFinite(waitMs) && waitMs > 0 ? waitMs : DEFAULT_RETRY_MS);
      continue;
    }

    const body = (await res.json()) as T;
    if (!body.ok) {
      throw new SlackError(
        `Slack ${method} failed: ${body.error ?? "unknown_error"}`,
        body.error ?? "unknown_error",
      );
    }
    return { body, res };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- validate (R29) --------------------------------------------------------

/**
 * Validate the bot token with auth.test. Returns ok:false with a clear message
 * on invalid_auth/not_authed (and other auth errors). On success, inspects the
 * granted scopes (response header `x-oauth-scopes`) and warns — without failing —
 * if they exceed the minimum this connector needs (R29, least-privilege
 * advisory). Missing required scopes are reported in the warning too.
 */
async function validate(creds: unknown): Promise<ValidationResult> {
  let token: string;
  try {
    token = asCreds(creds).token;
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }

  let res: Response;
  try {
    ({ res } = await slackCall(token, "auth.test"));
  } catch (error) {
    const code = error instanceof SlackError ? error.code : "unknown_error";
    if (code === "invalid_auth" || code === "not_authed" || code === "account_inactive" || code === "token_revoked") {
      return { ok: false, message: "Invalid or revoked Slack bot token." };
    }
    return { ok: false, message: (error as Error).message };
  }

  // Granted scopes are exposed on auth.test's response header. If absent (some
  // proxies strip it) we skip the advisory rather than guess.
  const granted = parseScopes(res.headers.get("x-oauth-scopes"));
  const scopeWarning = buildScopeWarning(granted);
  return scopeWarning ? { ok: true, scopeWarning } : { ok: true };
}

function parseScopes(header: string | null): string[] | undefined {
  if (!header) return undefined;
  return header
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Build a least-privilege advisory from the granted scopes. Flags missing
 * required scopes (likely to break sync) and excess scopes (R29 — advisory, not
 * a failure). Returns undefined when scopes are unknown or exactly minimal.
 */
function buildScopeWarning(granted: string[] | undefined): string | undefined {
  if (!granted) return undefined;
  const grantedSet = new Set(granted);
  const missing = MIN_SCOPES.filter((s) => !grantedSet.has(s));
  const minSet = new Set<string>(MIN_SCOPES);
  const excess = granted.filter((s) => !minSet.has(s));

  const parts: string[] = [];
  if (missing.length > 0) {
    parts.push(`missing required scope(s): ${missing.join(", ")}`);
  }
  if (excess.length > 0) {
    parts.push(
      `token grants ${excess.length} scope(s) beyond the minimum (${excess.join(", ")}) — consider least privilege`,
    );
  }
  return parts.length > 0 ? parts.join("; ") : undefined;
}

// --- listTargets -----------------------------------------------------------

/**
 * List public channels in the workspace (conversations.list, paginated via
 * cursor). Each target's id is the channel id and label is `#<name>`. A channel
 * the bot is not a member of is flagged via `note` (it will return empty until
 * the bot is invited) — surfaced distinctly per the plan, not hidden.
 */
async function listTargets(creds: unknown): Promise<ConnectorTarget[]> {
  const { token } = asCreds(creds);
  const targets: ConnectorTarget[] = [];
  let cursor: string | undefined;

  do {
    const { body } = await slackCall<SlackResponse & { channels?: SlackChannel[] }>(
      token,
      "conversations.list",
      {
        types: "public_channel",
        exclude_archived: "false",
        limit: 200,
        cursor,
      },
    );
    for (const ch of body.channels ?? []) {
      const note = noteForChannel(ch);
      targets.push({
        id: ch.id,
        label: `#${ch.name}`,
        ...(note ? { note } : {}),
      });
    }
    cursor = body.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return targets;
}

function noteForChannel(ch: SlackChannel): string | undefined {
  if (ch.is_archived) return "archived channel";
  if (ch.is_member === false) return "bot not a member — will return empty";
  return undefined;
}

// --- sync (R13 / KTD8a) ----------------------------------------------------

/**
 * Stream chunks for the selected channels. For each channel: page through
 * conversations.history; for each top-level message that roots a thread with
 * replies, fetch conversations.replies and chunk the whole thread together;
 * standalone messages are chunked alone. Author display names are resolved from
 * a single users.list fetch, cached id→name.
 *
 * A channel the bot cannot read (not_in_channel / channel_not_found) yields
 * nothing for that channel rather than throwing the whole sync (the orchestrator
 * records per-target results). Archived/empty channels naturally yield nothing.
 */
async function* sync(creds: unknown, channelIds: string[]): AsyncIterable<Chunk> {
  const { token } = asCreds(creds);

  // Resolve author names once (id → display name), cached across all channels.
  const userNames = await loadUserNames(token);
  const nameFor = (m: SlackMessage): string => {
    if (m.user && userNames.has(m.user)) return userNames.get(m.user) as string;
    if (m.bot_id) return "bot";
    return m.user ?? "unknown";
  };

  for (const channelId of channelIds) {
    yield* syncChannel(token, channelId, nameFor);
  }
}

/** Sync one channel; swallows per-channel read failures (yields nothing). */
async function* syncChannel(
  token: string,
  channelId: string,
  nameFor: (m: SlackMessage) => string,
): AsyncIterable<Chunk> {
  let cursor: string | undefined;

  try {
    do {
      const { body } = await slackCall<SlackResponse & { messages?: SlackMessage[] }>(
        token,
        "conversations.history",
        { channel: channelId, limit: 200, cursor },
      );

      for (const msg of body.messages ?? []) {
        if (!isContentMessage(msg)) continue;

        const isThreadRoot =
          msg.thread_ts === msg.ts && (msg.reply_count ?? 0) > 0;

        const thread = isThreadRoot
          ? await fetchThread(token, channelId, msg.ts)
          : [msg];

        yield* chunksForThread(token, channelId, thread, nameFor);
      }

      cursor = body.response_metadata?.next_cursor || undefined;
    } while (cursor);
  } catch (error) {
    // The bot isn't in the channel (or it vanished): yield nothing for it. The
    // orchestrator's per-target tally simply shows 0 chunks; we do not throw.
    const code = error instanceof SlackError ? error.code : "";
    if (code === "not_in_channel" || code === "channel_not_found" || code === "is_archived") {
      return;
    }
    throw error;
  }
}

/** Fetch a full thread (root + replies), paginated via cursor. */
async function fetchThread(
  token: string,
  channelId: string,
  threadTs: string,
): Promise<SlackMessage[]> {
  const messages: SlackMessage[] = [];
  let cursor: string | undefined;
  do {
    const { body } = await slackCall<SlackResponse & { messages?: SlackMessage[] }>(
      token,
      "conversations.replies",
      { channel: channelId, ts: threadTs, limit: 200, cursor },
    );
    for (const m of body.messages ?? []) {
      if (isContentMessage(m)) messages.push(m);
    }
    cursor = body.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return messages;
}

/**
 * Chunk a single thread (root + replies) and yield Chunks. The thread text is
 * the messages joined "<author>: <text>" in order; chunkText windows it on line
 * boundaries (KTD8a). The Document ref is the thread root's ts (or the message
 * ts for a standalone), so resync is stable (KTD7). title is
 * `#<channel> — <first author>`; snippet is the chunk body; permalink targets
 * the thread root.
 */
async function* chunksForThread(
  token: string,
  channelId: string,
  thread: SlackMessage[],
  nameFor: (m: SlackMessage) => string,
): AsyncIterable<Chunk> {
  if (thread.length === 0) return;

  const root = thread[0] as SlackMessage;
  const rootRef = root.thread_ts ?? root.ts;
  const firstAuthor = nameFor(root);

  const text = thread
    .map((m) => `${nameFor(m)}: ${(m.text ?? "").trim()}`)
    .join("\n")
    .trim();

  const bodies = chunkText(text);
  if (bodies.length === 0) return;

  const permalink = await permalinkFor(token, channelId, rootRef);
  const title = `#${channelId} — ${firstAuthor}`;

  for (let i = 0; i < bodies.length; i += 1) {
    const snippet = bodies[i] as string;
    yield {
      id: chunkId("slack", channelId, rootRef, i),
      contents: snippet,
      metadata: {
        connector: "slack",
        title,
        snippet,
        target: channelId,
        ref: rootRef,
        channel: channelId,
        author: firstAuthor,
        ts: rootRef,
        permalink,
      },
    };
  }
}

/**
 * A message we treat as ingestible content: a real user/standard message with
 * text. Skips join/leave/channel-event subtypes and empty bodies.
 */
function isContentMessage(m: SlackMessage): boolean {
  if (m.subtype && m.subtype !== "thread_broadcast" && m.subtype !== "bot_message") {
    return false;
  }
  return typeof m.text === "string" && m.text.trim().length > 0;
}

/**
 * Resolve a permalink for a message. Prefers chat.getPermalink; on any failure
 * falls back to a constructed archive URL so a chunk is never permalink-less.
 */
async function permalinkFor(
  token: string,
  channelId: string,
  ts: string,
): Promise<string> {
  try {
    const { body } = await slackCall<SlackResponse & { permalink?: string }>(
      token,
      "chat.getPermalink",
      { channel: channelId, message_ts: ts },
    );
    if (body.permalink) return body.permalink;
  } catch {
    // fall through to constructed link
  }
  // Constructed fallback: pXXX is the ts with the dot removed.
  const p = ts.replace(".", "");
  return `https://slack.com/archives/${channelId}/p${p}`;
}

/** Load all workspace users once (paginated) into an id → display-name map. */
async function loadUserNames(token: string): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  let cursor: string | undefined;
  try {
    do {
      const { body } = await slackCall<SlackResponse & { members?: SlackUser[] }>(
        token,
        "users.list",
        { limit: 200, cursor },
      );
      for (const u of body.members ?? []) {
        names.set(u.id, displayName(u));
      }
      cursor = body.response_metadata?.next_cursor || undefined;
    } while (cursor);
  } catch {
    // If users.list is unavailable (e.g. missing users:read), fall back to raw
    // user ids in author fields rather than failing the whole sync.
  }
  return names;
}

function displayName(u: SlackUser): string {
  return (
    u.profile?.display_name?.trim() ||
    u.profile?.real_name?.trim() ||
    u.name ||
    u.id
  );
}

/**
 * The Slack connector plugin. Registered under kind "slack" by the orchestrator
 * (registry import side-effect / explicit registration); this module exports the
 * value only.
 */
export const slackConnector: Connector = {
  kind: "slack",
  validate,
  listTargets,
  sync,
};

// Register on import so the orchestrator gets a populated registry simply by
// importing this module (the registry ships empty by design — U7 does not
// depend on the concrete connectors).
registerConnector(slackConnector);
