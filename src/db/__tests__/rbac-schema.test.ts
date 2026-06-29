// RBAC data-model tests (U1). Schema + constraint coverage only — role
// behavior lives in U2-U4. Prisma runs against the throwaway SQLite DB
// provisioned by the suite-wide setupFile (vitest.config.ts ->
// src/auth/__tests__/setup-env.ts), so this never touches a real dev.db.

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../client.js";

async function reset() {
  await prisma.membership.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.space.deleteMany();
  await prisma.user.deleteMany();
}

function makeUser(email: string) {
  return prisma.user.create({ data: { email, passwordHash: "x" } });
}

function makeSpace(slug: string) {
  return prisma.space.create({
    data: { slug, name: slug, indexKey: "00".repeat(32) },
  });
}

beforeEach(reset);
afterAll(async () => {
  await reset();
  await prisma.$disconnect();
});

describe("RBAC schema", () => {
  it("defaults a new user to the member role with no forced password change", async () => {
    const u = await makeUser("a@example.com");
    expect(u.workspaceRole).toBe("member");
    expect(u.mustChangePassword).toBe(false);
    expect(u.tempPasswordExpiresAt).toBeNull();
  });

  it("rejects a duplicate (userId, spaceId) membership", async () => {
    const u = await makeUser("a@example.com");
    const s = await makeSpace("alpha");
    await prisma.membership.create({ data: { userId: u.id, spaceId: s.id, role: "viewer" } });
    await expect(
      prisma.membership.create({ data: { userId: u.id, spaceId: s.id, role: "editor" } }),
    ).rejects.toThrow();
  });

  it("allows the same user to be a member of different spaces", async () => {
    const u = await makeUser("a@example.com");
    const s1 = await makeSpace("alpha");
    const s2 = await makeSpace("beta");
    await prisma.membership.create({ data: { userId: u.id, spaceId: s1.id, role: "editor" } });
    await prisma.membership.create({ data: { userId: u.id, spaceId: s2.id, role: "viewer" } });
    expect(await prisma.membership.count({ where: { userId: u.id } })).toBe(2);
  });

  it("cascades membership deletion when its space is deleted", async () => {
    const u = await makeUser("a@example.com");
    const s = await makeSpace("alpha");
    await prisma.membership.create({ data: { userId: u.id, spaceId: s.id, role: "viewer" } });
    await prisma.space.delete({ where: { id: s.id } });
    expect(await prisma.membership.count()).toBe(0);
    // The user survives the space deletion.
    expect(await prisma.user.count()).toBe(1);
  });

  it("cascades membership deletion when its user is deleted", async () => {
    const u = await makeUser("a@example.com");
    const s = await makeSpace("alpha");
    await prisma.membership.create({ data: { userId: u.id, spaceId: s.id, role: "editor" } });
    await prisma.user.delete({ where: { id: u.id } });
    expect(await prisma.membership.count()).toBe(0);
    // The space survives the user deletion.
    expect(await prisma.space.count()).toBe(1);
  });

  it("stores an audit row with nullable target/space and survives a referenced user's deletion", async () => {
    const actor = await makeUser("admin@example.com");
    const target = await makeUser("target@example.com");
    await prisma.auditLog.create({
      data: { actorUserId: actor.id, action: "account.create", targetUserId: target.id, outcome: "ok" },
    });
    await prisma.auditLog.create({
      data: { actorUserId: actor.id, action: "admin.demote", outcome: "rejected", detail: "last admin" },
    });
    // Deleting the target must NOT remove the audit row (no FK relation).
    await prisma.user.delete({ where: { id: target.id } });
    const rows = await prisma.auditLog.findMany({ orderBy: { createdAt: "asc" } });
    expect(rows).toHaveLength(2);
    expect(rows[0].targetUserId).toBe(target.id);
    expect(rows[1].outcome).toBe("rejected");
    expect(rows[1].targetUserId).toBeNull();
  });
});
