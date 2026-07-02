// GitHub connector. A PAT-authenticated adapter over the GitHub REST API v3 that
// validates the token's scope, lists accessible repos, and streams normalized
// Chunks for selected repos' files (code + docs) and issues (PRs excluded).
//
// What it does:
// - Ingests selected repos' files and issues, with repo / path-or-issue-ref /
//   permalink metadata.
// - Validates the token for the *minimum* required scope; warns (not fail) on
//   excess scope (least-privilege advisory).
// - Chunk IDs come from chunkId(connector, target, ref, index) so resync is
//   idempotent and purgeable.
// - Items returned by the issues endpoint that carry a `pull_request` field are
//   pull requests, not issues, and are excluded.
//
// No SDK (octokit): native `fetch` only, to keep the dependency set unchanged.

import { chunkId, chunkText } from "./chunk.js";
import type { Chunk, Connector, ConnectorTarget, ValidationResult } from "./types.js";

const CONNECTOR = "github" as const;
const API = "https://api.github.com";

/** Credentials for the GitHub connector: a personal access token (PAT). */
export interface GitHubCreds {
  token: string;
}

// Files larger than this are skipped — they are almost never useful retrieval
// units and blow the per-chunk budget (lockfiles, generated bundles, datasets).
const MAX_FILE_BYTES = 256 * 1024;

// Vendored / build-output / VCS directories whose contents are noise for
// retrieval. Matched as a path segment (so "vendor" matches "a/vendor/b.go").
const SKIP_DIRS = new Set(["node_modules", "vendor", "dist", "build", ".git"]);

// Binary / non-text file extensions to skip. Lowercase, no leading dot.
const BINARY_EXTS = new Set([
  // images
  "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "tiff", "svg",
  // archives
  "zip", "gz", "tar", "tgz", "rar", "7z", "bz2", "xz",
  // audio / video
  "mp3", "wav", "flac", "ogg", "mp4", "mov", "avi", "mkv", "webm",
  // docs / fonts
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "ttf", "otf", "woff", "woff2", "eot",
  // binaries / compiled
  "exe", "dll", "so", "dylib", "bin", "o", "a", "class", "jar", "wasm",
  "pyc", "pyo", "node",
  // data blobs
  "db", "sqlite", "lock",
]);

// Max retries when GitHub returns a 429 / secondary-rate-limit before giving up.
const MAX_RETRIES = 5;

/** Lowercase extension of a path (without the dot), or "" if none. */
function extOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return ""; // no dot, or dotfile like ".gitignore"
  return base.slice(dot + 1).toLowerCase();
}

/** Whether a tree path is in a skipped vendored / build / VCS directory. */
function inSkippedDir(path: string): boolean {
  return path.split("/").some((seg) => SKIP_DIRS.has(seg));
}

/** Whether a file path should be ingested as text. */
function isTextFile(path: string): boolean {
  if (inSkippedDir(path)) return false;
  return !BINARY_EXTS.has(extOf(path));
}

/** A short display excerpt of a chunk body for the source card (metadata.snippet). */
function snippetOf(body: string): string {
  const oneLine = body.replace(/\s+/g, " ").trim();
  return oneLine.length > 200 ? `${oneLine.slice(0, 200)}…` : oneLine;
}

/** Sleep helper for rate-limit backoff. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Perform a GitHub API request with the PAT, honoring 429 / secondary rate
 * limits via `Retry-After` (or an exponential fallback) up to MAX_RETRIES.
 * Returns the final Response; the caller checks `.ok` / status.
 */
async function ghFetch(token: string, url: string): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "context-well-connector",
  };

  let attempt = 0;
  for (;;) {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });

    // Primary (429) or secondary rate limit. The secondary limit can also arrive
    // as 403 with a Retry-After header; treat a present Retry-After as the signal.
    const retryAfter = res.headers.get("retry-after");
    const isRateLimited =
      res.status === 429 || (res.status === 403 && retryAfter !== null);

    if (isRateLimited && attempt < MAX_RETRIES) {
      attempt += 1;
      const waitMs = retryAfter
        ? Math.min(Number(retryAfter) * 1000, 60_000)
        : Math.min(2 ** attempt * 1000, 60_000);
      await sleep(Number.isFinite(waitMs) && waitMs > 0 ? waitMs : 1000);
      continue;
    }
    return res;
  }
}

/**
 * Walk a paginated GitHub list endpoint, following the RFC 5988 `Link: …
 * rel="next"` header, and return the concatenated items. `firstUrl` should carry
 * a `per_page` already.
 */
async function paginate<T>(token: string, firstUrl: string): Promise<T[]> {
  const out: T[] = [];
  let url: string | undefined = firstUrl;
  while (url) {
    const res = await ghFetch(token, url);
    if (!res.ok) {
      throw new Error(`GitHub ${res.status} for ${url}: ${await safeText(res)}`);
    }
    const page = (await res.json()) as T[];
    out.push(...page);
    url = nextLink(res.headers.get("link"));
  }
  return out;
}

/** Extract the `rel="next"` URL from a Link header, or undefined. */
function nextLink(link: string | null): string | undefined {
  if (!link) return undefined;
  for (const part of link.split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (m) return m[1];
  }
  return undefined;
}

/** Read a response body as text without throwing on a non-text body. */
async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "";
  }
}

// --- GitHub API response shapes (only the fields we read) ------------------

interface GhRepo {
  full_name: string;
  default_branch: string;
  private: boolean;
  visibility?: string;
}

interface GhTreeEntry {
  path: string;
  type: string; // "blob" | "tree" | "commit"
  size?: number;
  sha: string;
}

interface GhTree {
  tree: GhTreeEntry[];
  truncated: boolean;
}

interface GhBlob {
  content: string;
  encoding: string; // "base64" | "utf-8"
}

interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  comments: number;
  pull_request?: unknown; // present ⇒ this is a PR, not an issue
}

interface GhComment {
  body: string | null;
}

// --- Scope validation -------------------------------------------------------

// The minimum scopes this connector needs: read access to repo contents and
// issues. Classic PATs expose scopes via the x-oauth-scopes header. The classic
// scope that grants both is "repo" (there is no finer classic read-only scope);
// fine-grained tokens send an empty header. We treat anything beyond the read
// set below as "excess" for the advisory warning.
const MIN_SCOPES = ["repo", "public_repo", "read:org"];

// Scopes that clearly exceed read-of-contents-and-issues and warrant a warning.
const WRITE_OR_ADMIN_SCOPES = [
  "delete_repo",
  "admin:org",
  "admin:repo_hook",
  "admin:public_key",
  "admin:gpg_key",
  "write:packages",
  "delete:packages",
  "workflow",
  "user",
  "gist",
];

/**
 * Build a least-privilege advisory from the token's granted scopes. Returns
 * a warning string if the token carries scopes beyond what this connector needs,
 * else undefined. Never hard-fails.
 */
function scopeAdvisory(scopesHeader: string | null): string | undefined {
  if (!scopesHeader) return undefined; // fine-grained token: no classic scopes.
  const scopes = scopesHeader
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (scopes.length === 0) return undefined;

  const excess = scopes.filter(
    (s) =>
      WRITE_OR_ADMIN_SCOPES.some((w) => s === w || s.startsWith(`${w}:`)) ||
      (!MIN_SCOPES.includes(s) && !s.startsWith("read:")),
  );
  if (excess.length === 0) return undefined;
  return (
    `Token grants broader scope than needed (${excess.join(", ")}). ` +
    `This connector needs only read access to repository contents and issues. ` +
    `Consider a fine-grained token or a token limited to "repo" (read).`
  );
}

// --- Connector implementation ----------------------------------------------

function asCreds(creds: unknown): GitHubCreds {
  // Credentials are persisted as a raw token string (see routes.ts), but may
  // also arrive as a { token } object (e.g. unit tests). Accept either shape.
  const token =
    typeof creds === "string"
      ? creds
      : (creds as Partial<GitHubCreds> | null | undefined)?.token;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("GitHub credentials require a non-empty `token`.");
  }
  return { token };
}

async function validate(creds: unknown): Promise<ValidationResult> {
  let token: string;
  try {
    token = asCreds(creds).token;
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }

  let res: Response;
  try {
    res = await ghFetch(token, `${API}/user`);
  } catch (e) {
    return {
      ok: false,
      message: `Could not reach GitHub: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  if (res.status === 401) {
    return { ok: false, message: "Invalid GitHub token (401 Unauthorized)." };
  }
  if (!res.ok) {
    return {
      ok: false,
      message: `GitHub token check failed (${res.status}): ${await safeText(res)}`,
    };
  }

  const scopeWarning = scopeAdvisory(res.headers.get("x-oauth-scopes"));
  return scopeWarning ? { ok: true, scopeWarning } : { ok: true };
}

async function listTargets(creds: unknown): Promise<ConnectorTarget[]> {
  const { token } = asCreds(creds);
  const repos = await paginate<GhRepo>(
    token,
    `${API}/user/repos?per_page=100&sort=full_name`,
  );
  return repos.map((r) => ({
    id: r.full_name,
    label: r.full_name,
    note: r.visibility ?? (r.private ? "private" : "public"),
  }));
}

interface RepoTarget {
  owner: string;
  repo: string;
  // Explicit ref from a /tree/<branch>/… or /blob/<branch>/… URL; when unset the
  // caller falls back to the repo's default branch.
  branch?: string;
  // Path prefix to scope ingestion to (no leading/trailing slash). When set,
  // only files at or under this path are ingested. Undefined = whole repo.
  subpath?: string;
}

/**
 * Resolve a repo target to owner + repo, plus an optional branch + subpath when
 * a deep URL is given. Accepts:
 *   - "owner/repo"
 *   - "https://github.com/owner/repo(.git)" / "github.com/owner/repo"
 *   - "git@github.com:owner/repo"
 *   - "github.com/owner/repo/tree/<branch>/<folder…>"  → scope to that folder
 *   - "github.com/owner/repo/blob/<branch>/<file>"     → scope to that file
 * A `/tree|/blob/<branch>/<path>` URL scopes ingestion to <path> on <branch>;
 * a plain owner/repo ingests the whole default branch. Branch is taken as the
 * single segment after tree/blob (refs containing slashes are not disambiguated
 * without an API call — out of scope). Throws if owner or repo is missing.
 */
function parseRepoTarget(repoId: string): RepoTarget {
  const normalized = repoId
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/^(www\.)?github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  const [owner, repo, kind, branch, ...rest] = normalized.split("/").filter(Boolean);
  if (!owner || !repo) {
    throw new Error(`Malformed repo id "${repoId}" (expected "owner/repo").`);
  }
  if ((kind === "tree" || kind === "blob") && branch) {
    const subpath = rest.join("/") || undefined;
    return { owner, repo, branch, subpath };
  }
  return { owner, repo };
}

/** Fetch a repo's metadata (for the default branch). */
async function getRepo(token: string, owner: string, repo: string): Promise<GhRepo> {
  const res = await ghFetch(token, `${API}/repos/${owner}/${repo}`);
  if (!res.ok) {
    throw new Error(`GitHub ${res.status} for repo ${owner}/${repo}: ${await safeText(res)}`);
  }
  return (await res.json()) as GhRepo;
}

/** Whether a tree path is within the requested subpath scope (folder or file). */
function inSubpath(path: string, subpath: string | undefined): boolean {
  if (!subpath) return true; // whole repo
  return path === subpath || path.startsWith(`${subpath}/`);
}

/**
 * Stream Chunks for one repo's files. Walks the given branch's tree
 * recursively, skips binaries / vendored dirs / oversize blobs and (when
 * `subpath` is set) anything outside that folder/file, fetches blob contents for
 * the rest, and chunks each file's text with chunkText.
 */
async function* syncRepoFiles(
  token: string,
  repoId: string,
  owner: string,
  repo: string,
  branch: string,
  subpath?: string,
): AsyncGenerator<Chunk> {
  const treeRes = await ghFetch(
    token,
    `${API}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
  );
  // An empty repo (no commits) returns 409 Conflict on the tree — treat as 0 files.
  if (treeRes.status === 409) return;
  if (!treeRes.ok) {
    throw new Error(
      `GitHub ${treeRes.status} for tree ${owner}/${repo}@${branch}: ${await safeText(treeRes)}`,
    );
  }
  const tree = (await treeRes.json()) as GhTree;

  // A scoped target whose path matches NO tree entry (dir or file) is almost
  // always a typo (e.g. "versions/v0.17" vs "versions/v0.17.x"). Fail loudly so
  // it surfaces as an error instead of a silent "connected · 0 chunks". Skipped
  // when the tree came back truncated, since the path may just be off-page.
  if (subpath && !tree.truncated && !tree.tree.some((e) => inSubpath(e.path, subpath))) {
    throw new Error(
      `No files found under "${subpath}" in ${owner}/${repo}@${branch} — check the folder path.`,
    );
  }

  for (const entry of tree.tree) {
    if (entry.type !== "blob") continue;
    if (!inSubpath(entry.path, subpath)) continue;
    if (!isTextFile(entry.path)) continue;
    if (typeof entry.size === "number" && entry.size > MAX_FILE_BYTES) continue;

    const blobRes = await ghFetch(
      token,
      `${API}/repos/${owner}/${repo}/git/blobs/${entry.sha}`,
    );
    // A single unreadable blob shouldn't abort the whole repo's file pull.
    if (!blobRes.ok) continue;

    const blob = (await blobRes.json()) as GhBlob;
    let text: string;
    if (blob.encoding === "base64") {
      const buf = Buffer.from(blob.content, "base64");
      if (buf.byteLength > MAX_FILE_BYTES) continue; // size guard on actual bytes
      text = buf.toString("utf-8");
    } else {
      text = blob.content;
    }

    const permalink = `https://github.com/${owner}/${repo}/blob/${branch}/${entry.path}`;
    const bodies = chunkText(text);
    for (let index = 0; index < bodies.length; index += 1) {
      const body = bodies[index];
      yield {
        id: chunkId(CONNECTOR, repoId, entry.path, index),
        contents: body,
        metadata: {
          connector: CONNECTOR,
          title: entry.path,
          snippet: snippetOf(body),
          target: repoId,
          ref: entry.path,
          permalink,
        },
      };
    }
  }
}

/**
 * Stream Chunks for one repo's issues. Paginates issues in all
 * states, EXCLUDES pull requests (items with a `pull_request` field), and for
 * each issue combines title + body + comments, then chunks the combined text.
 */
async function* syncRepoIssues(
  token: string,
  repoId: string,
  owner: string,
  repo: string,
): AsyncGenerator<Chunk> {
  const issues = await paginate<GhIssue>(
    token,
    `${API}/repos/${owner}/${repo}/issues?state=all&per_page=100`,
  );

  for (const issue of issues) {
    if (issue.pull_request) continue; // exclude PRs

    let combined = `${issue.title}\n\n${issue.body ?? ""}`;
    if (issue.comments > 0) {
      const comments = await paginate<GhComment>(
        token,
        `${API}/repos/${owner}/${repo}/issues/${issue.number}/comments?per_page=100`,
      );
      for (const c of comments) {
        if (c.body) combined += `\n\n${c.body}`;
      }
    }

    const ref = `issue/${issue.number}`;
    const title = `#${issue.number} ${issue.title}`;
    const bodies = chunkText(combined);
    for (let index = 0; index < bodies.length; index += 1) {
      const body = bodies[index];
      yield {
        id: chunkId(CONNECTOR, repoId, ref, index),
        contents: body,
        metadata: {
          connector: CONNECTOR,
          title,
          snippet: snippetOf(body),
          target: repoId,
          ref,
          permalink: issue.html_url,
        },
      };
    }
  }
}

/**
 * Stream normalized Chunks for the selected repos. For each repo, yields
 * its file chunks then its issue chunks.
 *
 * Per-repo error policy (pragmatic): collect failures and continue to the next
 * repo so one bad repo yields a partial sync, not a total failure. Only if EVERY
 * selected repo fails do we throw an AggregateError so the orchestrator marks the
 * whole sync `error` rather than silently producing nothing.
 */
async function* sync(creds: unknown, repoIds: string[]): AsyncIterable<Chunk> {
  const { token } = asCreds(creds);
  const errors: Error[] = [];
  let succeeded = 0;

  for (const repoId of repoIds) {
    try {
      const { owner, repo, branch: refOverride, subpath } = parseRepoTarget(repoId);
      const meta = await getRepo(token, owner, repo);
      const branch = refOverride || meta.default_branch || "main";

      yield* syncRepoFiles(token, repoId, owner, repo, branch, subpath);
      // Issues are repo-wide, not folder-scoped: when the target narrows to a
      // subpath the intent is "just these docs", so we skip issues entirely.
      if (!subpath) yield* syncRepoIssues(token, repoId, owner, repo);
      succeeded += 1;
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      errors.push(new Error(`${repoId}: ${err.message}`));
      // Skip the failed repo and continue (orchestrator → partial).
      console.warn(`[github] skipping repo ${repoId}: ${err.message}`);
    }
  }

  // All repos failed and none produced chunks → surface a hard error.
  if (succeeded === 0 && errors.length > 0) {
    throw new AggregateError(errors, "All GitHub repos failed to sync.");
  }
}

/** The GitHub connector plugin (registered by the orchestrator). */
export const githubConnector: Connector = {
  kind: CONNECTOR,
  validate,
  listTargets,
  sync,
};

// Self-register on import (parity with the Slack connector; the registry is idempotent).
import { registerConnector } from "./registry.js";
registerConnector(githubConnector);
