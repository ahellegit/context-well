// Knowledge space service tests. The CyborgDB index-service is fully
// mocked (vi.mock) so no running cyborgdb-service is needed — these tests
// assert the DB-row + index orchestration: createSpace provisions an index and
// derives a unique slug, a provision failure rolls back the row, deleteSpace
// tears down the index before cascading rows, the custom prompt round-trips,
// and conversations/messages persist with an updatedAt touch.
//
// Prisma runs against the throwaway SQLite DB provisioned by the suite-wide
// setupFile (vitest.config.ts -> src/auth/__tests__/setup-env.ts).

import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the cyborg index-service. provisionIndex / deleteIndex are spies the
// service-under-test calls; provisionIndex stamps a key on the row the way the
// real one does (the real provisionIndex persists a minted key when absent).
const { provisionIndexMock, deleteIndexMock } = vi.hoisted(() => ({
  provisionIndexMock: vi.fn(),
  deleteIndexMock: vi.fn(),
}));

vi.mock("../../cyborg/index-service.js", () => ({
  provisionIndex: provisionIndexMock,
  deleteIndex: deleteIndexMock,
}));

const { prisma } = await import("../../db/client.js");
const {
  appendMessage,
  conversationOwner,
  createConversation,
  createSpace,
  deleteSpace,
  getConversation,
  getSpace,
  listConversations,
  listDocuments,
  listSpaces,
  slugify,
  updateCustomPrompt,
} = await import("../service.js");
const spacesRoutes = (await import("../routes.js")).default;

beforeEach(async () => {
  // Cascades clear connectors/documents/conversations/messages with the space.
  await prisma.space.deleteMany();
  // Conversations are now owned by a user; clear users too so per-test owners
  // don't collide on the unique email.
  await prisma.user.deleteMany();

  provisionIndexMock.mockReset();
  deleteIndexMock.mockReset();

  // Default: provisioning persists a minted key on the row (mirrors the real
  // provisionIndex), then resolves.
  provisionIndexMock.mockImplementation(async (ref: { id?: string }) => {
    if (ref.id) {
      await prisma.space.update({
        where: { id: ref.id },
        data: { indexKey: "a".repeat(64) },
      });
    }
    return "a".repeat(64);
  });
  deleteIndexMock.mockResolvedValue(undefined);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("slugify", () => {
  it("lowercases, strips punctuation, and collapses dashes", () => {
    expect(slugify("My Cool Space!!")).toBe("my-cool-space");
    expect(slugify("  Trim  Me  ")).toBe("trim-me");
  });

  it("falls back to 'space' for unusable names", () => {
    expect(slugify("🚀🚀")).toBe("space");
  });
});

describe("createSpace", () => {
  it("provisions an index and persists the minted key", async () => {
    const space = await createSpace({ name: "Engineering Docs" });

    expect(space.slug).toBe("engineering-docs");
    expect(space.name).toBe("Engineering Docs");
    expect(space.indexKey).toBe("a".repeat(64)); // persisted by provisionIndex
    expect(provisionIndexMock).toHaveBeenCalledTimes(1);
    expect(provisionIndexMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: space.id, slug: "engineering-docs" }),
    );

    // Row is queryable + listable immediately.
    expect(await getSpace(space.id)).not.toBeNull();
    const all = await listSpaces();
    expect(all.map((s) => s.id)).toContain(space.id);
  });

  it("derives a unique slug on a duplicate name", async () => {
    const a = await createSpace({ name: "Docs" });
    const b = await createSpace({ name: "Docs" });
    const c = await createSpace({ name: "Docs" });

    expect(a.slug).toBe("docs");
    expect(b.slug).toBe("docs-2");
    expect(c.slug).toBe("docs-3");
  });

  it("rolls back the row when provisioning fails", async () => {
    provisionIndexMock.mockRejectedValueOnce(new Error("cyborg down"));

    await expect(createSpace({ name: "Doomed" })).rejects.toThrow("cyborg down");

    // No orphaned row left behind.
    const all = await listSpaces();
    expect(all.find((s) => s.slug === "doomed")).toBeUndefined();
  });
});

describe("deleteSpace", () => {
  it("deletes the index before removing the row and cascades children", async () => {
    const space = await createSpace({ name: "To Delete" });
    const u = await prisma.user.create({ data: { email: "del@t.co", passwordHash: "x" } });
    const convo = await createConversation(space.id, u.id, "thread");
    await appendMessage(convo.id, { role: "user", text: "hi" });

    const order: string[] = [];
    deleteIndexMock.mockImplementationOnce(async () => {
      order.push("deleteIndex");
    });

    await deleteSpace(space.id);
    order.push("rowDeleted");

    expect(deleteIndexMock).toHaveBeenCalledWith(
      expect.objectContaining({ slug: space.slug }),
    );
    // Index torn down first, then the row.
    expect(order).toEqual(["deleteIndex", "rowDeleted"]);

    // Row gone, and the cascade removed its conversation + messages.
    expect(await getSpace(space.id)).toBeNull();
    expect(await getConversation(convo.id, u.id)).toBeNull();
  });
});

describe("updateCustomPrompt", () => {
  it("stores the raw {{var}} template verbatim (round-trip)", async () => {
    const space = await createSpace({ name: "Prompted" });
    const template = "You are {{space.name}}. Help {{user.name}}.";

    const updated = await updateCustomPrompt(space.id, template);
    expect(updated.customPrompt).toBe(template);

    // Re-read confirms persistence with no substitution applied.
    const reread = await getSpace(space.id);
    expect(reread?.customPrompt).toBe(template);
  });
});

describe("spacesRoutes — indexKey never crosses the API boundary (R29)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify();
    // The real app sets request.user via the protected-scope auth guard; stub an
    // owner here so the new RBAC route guards pass and we can assert the key is
    // stripped.
    app.addHook("preHandler", async (req) => {
      req.user = {
        id: "test-owner",
        email: "owner@test.local",
        createdAt: new Date(),
        workspaceRole: "owner",
        mustChangePassword: false,
      };
    });
    await app.register(spacesRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("omits indexKey from GET /api/spaces and POST /api/spaces responses", async () => {
    // POST creates a space (provisionIndex mock stamps an indexKey on the row).
    const created = await app.inject({
      method: "POST",
      url: "/api/spaces",
      payload: { name: "Secret Space" },
    });
    expect(created.statusCode).toBe(201);
    const createdBody = created.json();
    expect(createdBody.indexKey).toBeUndefined();
    expect(createdBody.slug).toBe("secret-space");
    // The raw key never appears anywhere in the serialized response.
    expect(created.payload).not.toContain("a".repeat(64));

    // GET lists spaces without the key.
    const listed = await app.inject({ method: "GET", url: "/api/spaces" });
    expect(listed.statusCode).toBe(200);
    const listedBody = listed.json() as Array<Record<string, unknown>>;
    expect(listedBody.length).toBeGreaterThan(0);
    for (const s of listedBody) expect(s.indexKey).toBeUndefined();
    expect(listed.payload).not.toContain("a".repeat(64));
  });
});

describe("conversations & messages", () => {
  it("creates, lists, and appends with an updatedAt touch", async () => {
    const space = await createSpace({ name: "Chatty" });
    const u = await prisma.user.create({ data: { email: "chatty@t.co", passwordHash: "x" } });

    const first = await createConversation(space.id, u.id);
    expect(first.title).toBe("New chat");
    const second = await createConversation(space.id, u.id, "Named thread");
    expect(second.title).toBe("Named thread");

    let convos = await listConversations(space.id, u.id);
    expect(convos).toHaveLength(2);

    // Append a message to the older conversation; updatedAt should bump it to
    // the top of the most-recently-updated-first list.
    const before = (await getConversation(first.id, u.id))!.updatedAt.getTime();
    // Ensure a measurable clock tick.
    await new Promise((r) => setTimeout(r, 5));

    const userMsg = await appendMessage(first.id, {
      role: "user",
      text: "What is RAG?",
    });
    expect(userMsg.role).toBe("user");

    const sources = [{ id: "v1", title: "doc", snippet: "…", score: 0.9 }];
    const asstMsg = await appendMessage(first.id, {
      role: "assistant",
      text: "Retrieval-augmented generation [1].",
      sources,
    });
    // Sources snapshot persisted as JSON.
    expect(JSON.parse(asstMsg.sources)).toEqual(sources);

    const reopened = await getConversation(first.id, u.id);
    expect(reopened!.messages).toHaveLength(2);
    expect(reopened!.messages[0].text).toBe("What is RAG?");
    expect(reopened!.messages[1].text).toBe(
      "Retrieval-augmented generation [1].",
    );
    // updatedAt advanced past the pre-append value.
    expect(reopened!.updatedAt.getTime()).toBeGreaterThan(before);

    // first is now most-recently-updated, so it sorts ahead of second.
    convos = await listConversations(space.id, u.id);
    expect(convos[0].id).toBe(first.id);
  });
});

describe("conversation privacy — threads are per-user", () => {
  it("a member only lists/opens their own conversations, never another's", async () => {
    const space = await createSpace({ name: "Shared" });
    const alice = await prisma.user.create({ data: { email: "alice@t.co", passwordHash: "x" } });
    const bob = await prisma.user.create({ data: { email: "bob@t.co", passwordHash: "x" } });

    const aConvo = await createConversation(space.id, alice.id, "alice thread");
    const bConvo = await createConversation(space.id, bob.id, "bob thread");

    // Each sees only their own in the shared space.
    const aList = await listConversations(space.id, alice.id);
    expect(aList.map((c) => c.id)).toEqual([aConvo.id]);
    const bList = await listConversations(space.id, bob.id);
    expect(bList.map((c) => c.id)).toEqual([bConvo.id]);

    // Alice cannot open Bob's thread (null = indistinguishable from missing).
    expect(await getConversation(bConvo.id, alice.id)).toBeNull();
    // Her own opens fine.
    expect((await getConversation(aConvo.id, alice.id))?.id).toBe(aConvo.id);

    // Ownership lookup (used by the chat route to 404 a non-owner's POST).
    expect(await conversationOwner(bConvo.id)).toBe(bob.id);
    expect(await conversationOwner(aConvo.id)).toBe(alice.id);
  });
});

describe("listDocuments — files in context", () => {
  it("lists indexed documents with connector kind and chunk counts", async () => {
    const space = await createSpace({ name: "Docs Space" });
    const connector = await prisma.connector.create({
      data: { spaceId: space.id, kind: "upload", credentials: "" },
    });
    await prisma.document.create({
      data: {
        spaceId: space.id,
        connectorId: connector.id,
        externalRef: "runbook.md",
        title: "runbook.md",
        vectors: { create: [{ vectorId: "v1" }, { vectorId: "v2" }, { vectorId: "v3" }] },
      },
    });
    await prisma.document.create({
      data: {
        spaceId: space.id,
        connectorId: connector.id,
        externalRef: "notes.md",
        title: "notes.md",
        vectors: { create: [{ vectorId: "n1" }] },
      },
    });

    const docs = await listDocuments(space.id);
    expect(docs).toHaveLength(2);
    const byTitle = Object.fromEntries(docs.map((d) => [d.title, d]));
    expect(byTitle["runbook.md"].connector).toBe("upload");
    expect(byTitle["runbook.md"].chunks).toBe(3);
    expect(byTitle["notes.md"].chunks).toBe(1);
  });

  it("returns an empty list for a space with no documents", async () => {
    const space = await createSpace({ name: "Empty Space" });
    expect(await listDocuments(space.id)).toEqual([]);
  });
});
