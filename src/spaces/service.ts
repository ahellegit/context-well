// Knowledge space service (U6). Owns Space CRUD (provisioning/tearing down the
// CyborgDB index alongside the DB row), the raw custom-prompt template, and the
// per-space conversation/message history.
//
// Requirements: R3 (a space owns its prompt, index, conversations), R7 (create
// provisions an index, delete removes it), R19 (conversations persist per space
// with messages, sources, and updated time), R20 (custom prompt stored raw with
// `{{var}}` placeholders; substitution happens at chat time in U10).
//
// The CyborgDB lifecycle lives in src/cyborg/index-service.ts; this service
// orchestrates DB-row + index consistency. Provisioning is wrapped so a failed
// index create never leaves an orphaned Space row, and deletion tears the index
// down before the row so a failed teardown never orphans the index (R7).

import type { Conversation, Message, Space } from "@prisma/client";
import { prisma } from "../db/client.js";
import {
  deleteIndex,
  provisionIndex,
  type SpaceRef,
} from "../cyborg/index-service.js";

// --- Public projection -----------------------------------------------------

// A Space without its secret 32-byte index key (KTD4/KTD5). Used everywhere a
// Space crosses the API boundary so the key never reaches the browser (R29).
export type PublicSpace = Omit<Space, "indexKey">;

/** Strip the secret indexKey from a Space before it crosses the API boundary. */
export function publicSpace(space: Space): PublicSpace {
  const { indexKey: _indexKey, ...rest } = space;
  return rest;
}

// --- Slug derivation -------------------------------------------------------

/**
 * Derive a URL/index-safe base slug from a free-text name: lowercase, ASCII
 * alphanumerics and dashes only, collapsed and trimmed. Falls back to "space"
 * when the name has no usable characters (e.g. emoji-only).
 */
export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return base.length > 0 ? base : "space";
}

/**
 * Produce a slug unique against existing Space rows. Appends -2, -3, … to the
 * base until it does not collide. The slug is the CyborgDB index name
 * (namespace-as-slug, KTD2), so it must be unique workspace-wide.
 */
async function uniqueSlug(name: string): Promise<string> {
  const base = slugify(name);
  let candidate = base;
  let n = 1;
  // Loop until an unused slug is found. Bounded in practice by the number of
  // existing spaces sharing the base name.
  while (await prisma.space.findUnique({ where: { slug: candidate } })) {
    n += 1;
    candidate = `${base}-${n}`;
  }
  return candidate;
}

// --- Space CRUD ------------------------------------------------------------

export interface CreateSpaceInput {
  name: string;
}

/**
 * Create a space: derive a unique slug, persist the Space row, then provision
 * its CyborgDB index. If provisioning throws, the row is rolled back (deleted)
 * and the error rethrown so we never leave a space without a working index
 * (R7). provisionIndex mints + persists the index key on the row when it has no
 * key yet, so the returned space is re-read to carry the freshly stored key.
 */
export async function createSpace(input: CreateSpaceInput): Promise<Space> {
  const name = input.name.trim();
  const slug = await uniqueSlug(name);

  const space = await prisma.space.create({
    data: { name, slug, indexKey: "" },
  });

  try {
    await provisionIndex(toRef(space));
  } catch (error) {
    // Roll back the orphaned row, then surface the provisioning failure.
    await prisma.space.delete({ where: { id: space.id } });
    throw error;
  }

  // provisionIndex persisted the minted key on the row; re-read so callers see it.
  return prisma.space.findUniqueOrThrow({ where: { id: space.id } });
}

/** All spaces, newest first. */
export function listSpaces(): Promise<Space[]> {
  return prisma.space.findMany({ orderBy: { createdAt: "desc" } });
}

/**
 * Spaces visible to a caller (R7): every space for a workspace owner/admin, and
 * only spaces the caller is a member of otherwise. Newest first.
 */
export function listSpacesForUser(userId: string, workspaceRole: string): Promise<Space[]> {
  if (workspaceRole === "owner" || workspaceRole === "admin") {
    return listSpaces();
  }
  return prisma.space.findMany({
    where: { memberships: { some: { userId } } },
    orderBy: { createdAt: "desc" },
  });
}

/** A single space by id, or null if it does not exist. */
export function getSpace(id: string): Promise<Space | null> {
  return prisma.space.findUnique({ where: { id } });
}

/**
 * Delete a space: tear down its CyborgDB index first, then cascade-delete the
 * row (Prisma `onDelete: Cascade` removes connectors, documents, conversations,
 * and messages). Teardown order matters — deleting the index first means a
 * failure leaves the row intact and retryable rather than orphaning the index
 * (R7). The connector sync lock (U7) is not consulted here; that concern lives
 * with the sync orchestrator.
 */
export async function deleteSpace(id: string): Promise<void> {
  const space = await prisma.space.findUniqueOrThrow({ where: { id } });
  await deleteIndex(toRef(space));
  await prisma.space.delete({ where: { id } });
}

/**
 * Store the raw custom-prompt template for a space (R3/R20). The `{{var}}`
 * placeholders are kept verbatim; substitution is deferred to chat time (U10).
 */
export function updateCustomPrompt(id: string, prompt: string): Promise<Space> {
  return prisma.space.update({
    where: { id },
    data: { customPrompt: prompt },
  });
}

// Narrow a Space row to the structural SpaceRef the index-service accepts.
function toRef(space: Space): SpaceRef {
  return {
    id: space.id,
    slug: space.slug,
    indexKey: space.indexKey,
    embeddingModel: space.embeddingModel,
  };
}

// --- Conversations & messages (R19) ----------------------------------------

export interface SpaceDocument {
  id: string;
  title: string;
  externalRef: string;
  connector: string; // connector kind: "github" | "slack" | "upload"
  chunks: number; // number of vectors (DocumentVector rows) for this document
}

/**
 * The documents currently indexed in a space (the "files in context"): one per
 * ingested source unit (uploaded file, GitHub file/issue, Slack thread), with
 * its connector kind and chunk count. Grouped by connector, titled A→Z.
 */
export async function listDocuments(spaceId: string): Promise<SpaceDocument[]> {
  const docs = await prisma.document.findMany({
    where: { spaceId },
    include: {
      connector: { select: { kind: true } },
      _count: { select: { vectors: true } },
    },
    orderBy: [{ connectorId: "asc" }, { title: "asc" }],
  });
  return docs.map((d) => ({
    id: d.id,
    title: d.title,
    externalRef: d.externalRef,
    connector: d.connector?.kind ?? "unknown",
    chunks: d._count.vectors,
  }));
}

/**
 * A user's own conversations in a space, most-recently-updated first.
 * Conversations are private (R: per-user chat privacy): scoped to `userId`.
 */
export function listConversations(spaceId: string, userId: string): Promise<Conversation[]> {
  return prisma.conversation.findMany({
    where: { spaceId, userId },
    orderBy: { updatedAt: "desc" },
  });
}

/** Start a new conversation in a space, owned by `userId` (its only viewer). */
export function createConversation(
  spaceId: string,
  userId: string,
  title?: string,
): Promise<Conversation> {
  return prisma.conversation.create({
    data: { spaceId, userId, ...(title ? { title } : {}) },
  });
}

// Default title a conversation is created with (Prisma schema default). A
// conversation still carrying this is "unnamed" and eligible for auto-naming.
export const DEFAULT_CONVERSATION_TITLE = "New chat";

/**
 * Derive a short conversation title from the first user message: whitespace
 * collapsed, trimmed to ~48 chars on a word boundary with an ellipsis.
 */
export function deriveConversationTitle(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  if (t.length === 0) return DEFAULT_CONVERSATION_TITLE;
  if (t.length <= 48) return t;
  return t.slice(0, 48).replace(/\s+\S*$/, "") + "…";
}

/** Set a conversation's title (used to auto-name from the first query). */
export function setConversationTitle(
  id: string,
  title: string,
): Promise<Conversation> {
  return prisma.conversation.update({ where: { id }, data: { title } });
}

/**
 * A user's own conversation with its messages in chronological order, or null
 * if it doesn't exist OR isn't owned by `userId`. Conversations are private, so
 * a non-owner (admins included) gets `null` — indistinguishable from "missing".
 */
export function getConversation(
  id: string,
  userId: string,
): Promise<(Conversation & { messages: Message[] }) | null> {
  return prisma.conversation.findFirst({
    where: { id, userId },
    include: { messages: { orderBy: { createdAt: "asc" } } },
  });
}

/** The owning userId of a conversation (or null if missing). For ownership checks. */
export async function conversationOwner(id: string): Promise<string | null> {
  const c = await prisma.conversation.findUnique({ where: { id }, select: { userId: true } });
  return c?.userId ?? null;
}

export interface AppendMessageInput {
  role: string; // "user" | "assistant"
  text: string;
  // Full snapshot of cited source cards (R30); serialized to JSON for storage.
  sources?: unknown[];
}

/**
 * Append a message to a conversation and touch the conversation's `updatedAt`
 * so the thread floats to the top of the list (R19). The two writes run in a
 * transaction so the timestamp and the message stay consistent. The `sources`
 * snapshot is stored as JSON text (R30).
 */
export async function appendMessage(
  conversationId: string,
  input: AppendMessageInput,
): Promise<Message> {
  const sourcesJson = JSON.stringify(input.sources ?? []);

  const [message] = await prisma.$transaction([
    prisma.message.create({
      data: {
        conversationId,
        role: input.role,
        text: input.text,
        sources: sourcesJson,
      },
    }),
    // Bump updatedAt explicitly: an empty `data` update is a no-op in Prisma, so
    // set the field to a fresh timestamp to guarantee the thread re-sorts.
    prisma.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    }),
  ]);

  return message;
}
