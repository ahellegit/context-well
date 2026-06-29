// Members management tests (U4): account creation, role grant/change/revoke,
// promote/demote with invariants, password reset, audit, and session teardown —
// plus route-level admin/owner guards. Prisma runs against the throwaway DB.
// Covers AE3, AE4 and R5.

import argon2 from "argon2";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyRateLimit from "@fastify/rate-limit";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "../../db/client.js";
import { createSession, verifyLogin } from "../../auth/service.js";
import type { AuthUser } from "../../auth/types.js";
import membersRoutes from "../routes.js";
import {
  MemberActionError,
  createAccount,
  demoteAdmin,
  promoteAdmin,
  resetPassword,
  revokeRole,
  setRole,
} from "../service.js";

async function makeUser(email: string, workspaceRole: string, passwordHash = "x") {
  return prisma.user.create({ data: { email, passwordHash, workspaceRole } });
}
function makeSpace(slug: string) {
  return prisma.space.create({ data: { slug, name: slug, indexKey: "x" } });
}

let actor: string; // an admin performing the actions

beforeEach(async () => {
  await prisma.auditLog.deleteMany();
  await prisma.membership.deleteMany();
  await prisma.session.deleteMany();
  await prisma.space.deleteMany();
  await prisma.user.deleteMany();
  actor = (await makeUser("admin@t", "admin")).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("createAccount", () => {
  it("creates a forced-change member with a temp password and no session", async () => {
    const { user, tempPassword } = await createAccount(actor, "New.Person@T ");
    expect(user.email).toBe("new.person@t");
    expect(user.workspaceRole).toBe("member");
    expect(user.mustChangePassword).toBe(true);
    expect(tempPassword.length).toBeGreaterThanOrEqual(16);
    // No auto-login.
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
    // The temp password actually works for a login.
    expect(await verifyLogin("new.person@t", tempPassword)).not.toBeNull();
    // Audited.
    const log = await prisma.auditLog.findFirst({ where: { action: "account.create" } });
    expect(log?.outcome).toBe("ok");
    expect(log?.targetUserId).toBe(user.id);
  });

  it("rejects a duplicate email with 409", async () => {
    await createAccount(actor, "dupe@t");
    await expect(createAccount(actor, "dupe@t")).rejects.toMatchObject({ status: 409 });
  });
});

describe("setRole / revokeRole", () => {
  it("grants a new role without dropping sessions and audits role.grant", async () => {
    const target = await makeUser("u@t", "member");
    const space = await makeSpace("a");
    await createSession(target.id);

    await setRole(actor, target.id, space.id, "editor");

    const m = await prisma.membership.findUnique({
      where: { userId_spaceId: { userId: target.id, spaceId: space.id } },
    });
    expect(m?.role).toBe("editor");
    // A fresh grant does not evict the session.
    expect(await prisma.session.count({ where: { userId: target.id } })).toBe(1);
    expect((await prisma.auditLog.findFirst({ where: { action: "role.grant" } }))?.role).toBe("editor");
  });

  it("AE4 — changing a role downgrades and drops the target's sessions", async () => {
    const target = await makeUser("u@t", "member");
    const space = await makeSpace("a");
    await setRole(actor, target.id, space.id, "editor");
    await createSession(target.id);

    await setRole(actor, target.id, space.id, "viewer");

    const m = await prisma.membership.findUnique({
      where: { userId_spaceId: { userId: target.id, spaceId: space.id } },
    });
    expect(m?.role).toBe("viewer");
    expect(await prisma.session.count({ where: { userId: target.id } })).toBe(0);
    expect(await prisma.auditLog.findFirst({ where: { action: "role.change" } })).not.toBeNull();
  });

  it("AE3 — revoke removes the membership, drops sessions, and audits", async () => {
    const target = await makeUser("u@t", "member");
    const space = await makeSpace("a");
    await setRole(actor, target.id, space.id, "viewer");
    await createSession(target.id);

    await revokeRole(actor, target.id, space.id);

    expect(await prisma.membership.count({ where: { userId: target.id } })).toBe(0);
    expect(await prisma.session.count({ where: { userId: target.id } })).toBe(0);
    expect(await prisma.auditLog.findFirst({ where: { action: "role.revoke" } })).not.toBeNull();
  });

  it("rejects an invalid role and an unknown user/space", async () => {
    const target = await makeUser("u@t", "member");
    const space = await makeSpace("a");
    await expect(setRole(actor, target.id, space.id, "admin")).rejects.toMatchObject({ status: 400 });
    await expect(setRole(actor, "nope", space.id, "viewer")).rejects.toMatchObject({ status: 404 });
  });
});

describe("promote / demote invariants (R5)", () => {
  it("promotes a member and demotes an admin while the owner remains", async () => {
    await makeUser("owner@t", "owner");
    const target = await makeUser("u@t", "member");

    await promoteAdmin(actor, target.id);
    expect((await prisma.user.findUnique({ where: { id: target.id } }))?.workspaceRole).toBe("admin");

    await createSession(target.id);
    await demoteAdmin(actor, target.id);
    expect((await prisma.user.findUnique({ where: { id: target.id } }))?.workspaceRole).toBe("member");
    expect(await prisma.session.count({ where: { userId: target.id } })).toBe(0);
  });

  it("refuses to demote the owner and audits the rejection", async () => {
    const owner = await makeUser("owner@t", "owner");
    await expect(demoteAdmin(actor, owner.id)).rejects.toMatchObject({ status: 403 });
    const log = await prisma.auditLog.findFirst({ where: { action: "admin.demote", outcome: "rejected" } });
    expect(log?.targetUserId).toBe(owner.id);
  });

  it("refuses a demotion that would leave zero admins", async () => {
    // A lone admin, no owner (the `actor`). Demoting them would zero the admins.
    await expect(demoteAdmin(actor, actor)).rejects.toMatchObject({ status: 409 });
    expect(
      await prisma.auditLog.findFirst({ where: { action: "admin.demote", outcome: "rejected", detail: "last admin" } }),
    ).not.toBeNull();
  });
});

describe("resetPassword", () => {
  it("issues a new temp password, drops sessions, and preserves memberships", async () => {
    const target = await makeUser("u@t", "member", await argon2.hash("old-password-1"));
    const space = await makeSpace("a");
    await setRole(actor, target.id, space.id, "editor");
    await createSession(target.id);

    const { tempPassword } = await resetPassword(actor, target.id);

    expect(await prisma.session.count({ where: { userId: target.id } })).toBe(0);
    // Old password no longer works; the new temp one does.
    expect(await verifyLogin("u@t", "old-password-1")).toBeNull();
    expect(await verifyLogin("u@t", tempPassword)).not.toBeNull();
    // Membership preserved.
    expect(await prisma.membership.count({ where: { userId: target.id } })).toBe(1);
    expect(await prisma.auditLog.findFirst({ where: { action: "password.reset" } })).not.toBeNull();
  });
});

describe("route guards", () => {
  let app: FastifyInstance;
  let current: AuthUser | null = null;

  function asUser(id: string, workspaceRole: string): AuthUser {
    return { id, email: `${id}@t`, createdAt: new Date(), workspaceRole, mustChangePassword: false };
  }

  beforeEach(async () => {
    app = Fastify();
    await app.register(fastifyRateLimit, { global: false });
    app.addHook("preHandler", async (req, reply) => {
      if (!current) return reply.code(401).send({ error: "unauthorized" });
      req.user = current;
    });
    await app.register(membersRoutes);
    await app.ready();
    current = null;
  });

  it("a plain member cannot reach any members route", async () => {
    const m = await makeUser("plain@t", "member");
    current = asUser(m.id, "member");
    expect((await app.inject({ method: "GET", url: "/api/members" })).statusCode).toBe(403);
  });

  it("an admin can list members and create accounts but cannot promote", async () => {
    current = asUser(actor, "admin");
    expect((await app.inject({ method: "GET", url: "/api/members" })).statusCode).toBe(200);

    const created = await app.inject({ method: "POST", url: "/api/members", payload: { email: "fresh@t" } });
    expect(created.statusCode).toBe(201);
    expect(created.json().tempPassword.length).toBeGreaterThanOrEqual(16);

    const target = await prisma.user.findUniqueOrThrow({ where: { email: "fresh@t" } });
    const promote = await app.inject({ method: "POST", url: `/api/members/${target.id}/promote` });
    expect(promote.statusCode).toBe(403); // owner-only
  });

  it("the owner can promote", async () => {
    const owner = await makeUser("owner@t", "owner");
    const target = await makeUser("u@t", "member");
    current = asUser(owner.id, "owner");
    const promote = await app.inject({ method: "POST", url: `/api/members/${target.id}/promote` });
    expect(promote.statusCode).toBe(204);
    expect((await prisma.user.findUnique({ where: { id: target.id } }))?.workspaceRole).toBe("admin");
  });
});
