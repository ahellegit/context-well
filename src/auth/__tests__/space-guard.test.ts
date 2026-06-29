// Authorization-layer tests (U3). Isolates authz from authn: instead of the
// cookie-based requireAuth, a preHandler stamps a test-controlled `request.user`
// (as the real protected scope would after login), then the REAL space/connector
// route plugins run with their requireSpaceRole/requireWorkspaceRole guards.
// CyborgDB is mocked so no service is needed. Covers AE1, AE2, AE5 + default-deny.

import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../cyborg/index-service.js", () => ({
  provisionIndex: vi.fn(),
  deleteIndex: vi.fn(),
  listIds: vi.fn(async () => [] as string[]),
  deleteVectors: vi.fn(),
}));

const { prisma } = await import("../../db/client.js");
const spacesRoutes = (await import("../../spaces/routes.js")).default;
const connectorsRoutes = (await import("../../connectors/routes.js")).default;
import type { AuthUser } from "../types.js";

// The principal the stub guard attaches; each test sets it before injecting.
let currentUser: AuthUser | null = null;

function asUser(id: string, workspaceRole: string): AuthUser {
  return { id, email: `${id}@test.local`, createdAt: new Date(), workspaceRole, mustChangePassword: false };
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  // Stand in for requireAuth: attach the test principal (or 401 when none).
  app.addHook("preHandler", async (req, reply) => {
    if (!currentUser) {
      await reply.code(401).send({ error: "unauthorized" });
      return;
    }
    req.user = currentUser;
  });
  await app.register(spacesRoutes);
  await app.register(connectorsRoutes);
  await app.ready();
  return app;
}

let app: FastifyInstance;
// Seeded ids.
let owner: string, alice: string, carol: string;
let spaceA: string, spaceB: string;
let convB: string, connB: string;

beforeEach(async () => {
  await prisma.membership.deleteMany();
  await prisma.connector.deleteMany();
  await prisma.conversation.deleteMany();
  await prisma.space.deleteMany();
  await prisma.user.deleteMany();

  owner = (await prisma.user.create({ data: { email: "owner@t", passwordHash: "x", workspaceRole: "owner" } })).id;
  alice = (await prisma.user.create({ data: { email: "alice@t", passwordHash: "x", workspaceRole: "member" } })).id;
  carol = (await prisma.user.create({ data: { email: "carol@t", passwordHash: "x", workspaceRole: "member" } })).id;

  spaceA = (await prisma.space.create({ data: { slug: "a", name: "A", indexKey: "x" } })).id;
  spaceB = (await prisma.space.create({ data: { slug: "b", name: "B", indexKey: "x" } })).id;

  // alice edits A, carol views A; nobody is a member of B.
  await prisma.membership.create({ data: { userId: alice, spaceId: spaceA, role: "editor" } });
  await prisma.membership.create({ data: { userId: carol, spaceId: spaceA, role: "viewer" } });

  convB = (await prisma.conversation.create({ data: { spaceId: spaceB } })).id;
  connB = (await prisma.connector.create({ data: { spaceId: spaceB, kind: "github", credentials: "x" } })).id;

  currentUser = null;
  app = await buildApp();
});

afterAll(async () => {
  await prisma.$disconnect();
});

function get(url: string) {
  return app.inject({ method: "GET", url });
}

describe("AE1 — space list + cross-space route isolation", () => {
  it("editor of A sees only A in the list; non-member calls to B's routes 403", async () => {
    currentUser = asUser(alice, "member");

    const list = await get("/api/spaces");
    expect(list.statusCode).toBe(200);
    const ids = (list.json() as Array<{ id: string }>).map((s) => s.id);
    expect(ids).toContain(spaceA);
    expect(ids).not.toContain(spaceB);

    // A's read route works; B's does not.
    expect((await get(`/api/spaces/${spaceA}/documents`)).statusCode).toBe(200);
    expect((await get(`/api/spaces/${spaceB}/documents`)).statusCode).toBe(403);
    // B's connector list is also denied.
    expect((await get(`/api/spaces/${spaceB}/connectors`)).statusCode).toBe(403);
  });

  it("admin/owner sees all spaces and reaches B without a membership", async () => {
    currentUser = asUser(owner, "owner");
    const list = await get("/api/spaces");
    const ids = (list.json() as Array<{ id: string }>).map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining([spaceA, spaceB]));
    expect((await get(`/api/spaces/${spaceB}/documents`)).statusCode).toBe(200);
  });
});

describe("AE2 — viewer cannot write, editor can", () => {
  it("a viewer reads but cannot edit the prompt or upload-class routes", async () => {
    currentUser = asUser(carol, "member");
    expect((await get(`/api/spaces/${spaceA}/documents`)).statusCode).toBe(200);
    const put = await app.inject({
      method: "PUT",
      url: `/api/spaces/${spaceA}/prompt`,
      payload: { prompt: "hi" },
    });
    expect(put.statusCode).toBe(403);
  });

  it("an editor can edit the prompt", async () => {
    currentUser = asUser(alice, "member");
    const put = await app.inject({
      method: "PUT",
      url: `/api/spaces/${spaceA}/prompt`,
      payload: { prompt: "hi" },
    });
    expect(put.statusCode).toBe(200);
  });
});

describe("default-deny with no existence oracle", () => {
  it("returns the same 403 for a real non-member space and a nonexistent space id", async () => {
    currentUser = asUser(alice, "member");
    const real = await get(`/api/spaces/${spaceB}/documents`);
    const bogus = await get(`/api/spaces/does-not-exist/documents`);
    expect(real.statusCode).toBe(403);
    expect(bogus.statusCode).toBe(403);
    expect(real.json()).toEqual(bogus.json());
  });

  it("AE5 — IDOR: a conversation/connector in B is 403, indistinguishable from a bogus id", async () => {
    currentUser = asUser(alice, "member");
    // Conversation resolver: B's conversation vs a nonexistent conversation id.
    const convReal = await get(`/api/conversations/${convB}`);
    const convBogus = await get(`/api/conversations/nope`);
    expect(convReal.statusCode).toBe(403);
    expect(convBogus.statusCode).toBe(403);
    // Connector resolver: deleting B's connector is denied.
    const del = await app.inject({ method: "DELETE", url: `/api/connectors/${connB}` });
    expect(del.statusCode).toBe(403);
  });
});

describe("space create/delete is workspace-admin only", () => {
  it("a plain member cannot create a space; the owner can", async () => {
    currentUser = asUser(alice, "member");
    const denied = await app.inject({ method: "POST", url: "/api/spaces", payload: { name: "New" } });
    expect(denied.statusCode).toBe(403);

    currentUser = asUser(owner, "owner");
    const ok = await app.inject({ method: "POST", url: "/api/spaces", payload: { name: "New" } });
    expect(ok.statusCode).toBe(201);
  });

  it("a member cannot delete a space", async () => {
    currentUser = asUser(alice, "member");
    const del = await app.inject({ method: "DELETE", url: `/api/spaces/${spaceA}` });
    expect(del.statusCode).toBe(403);
  });
});

describe("unauthenticated", () => {
  it("401s when no principal is attached", async () => {
    currentUser = null;
    expect((await get("/api/spaces")).statusCode).toBe(401);
  });
});
