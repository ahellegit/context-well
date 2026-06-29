// Members & account management service (U4). Admin-driven account creation,
// per-space role grant/change/revoke, admin promote/demote, and password reset —
// each audited, with the last-admin / owner-immutable invariants enforced and
// the target's sessions dropped when a change should take effect immediately.
//
// This is the app-layer design: no CyborgDB tokens and no key-wrapping (those
// live on the crypto branch). "Revocation" is a Membership row delete plus a
// session drop; guards re-read the DB each request, so access changes are
// immediate. Implements R3, R4, R5, R9, R11, R14, R15.

import { randomBytes } from "node:crypto";
import argon2 from "argon2";
import type { User } from "@prisma/client";
import { prisma } from "../db/client.js";
import { dropSessionsForUser } from "../auth/service.js";

// Temp passwords are valid for 7 days; after that the account needs another
// admin reset (verifyLogin rejects an expired temp password — U2).
const TEMP_PASSWORD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const SPACE_ROLES = new Set(["editor", "viewer"]);

/** Public, browser-safe view of a member (never the hash or temp-pw expiry). */
export type PublicMember = Pick<User, "id" | "email" | "workspaceRole" | "mustChangePassword" | "createdAt">;

export interface MemberWithRoles extends PublicMember {
  memberships: { spaceId: string; role: string }[];
}

function toPublicMember(u: User): PublicMember {
  return {
    id: u.id,
    email: u.email,
    workspaceRole: u.workspaceRole,
    mustChangePassword: u.mustChangePassword,
    createdAt: u.createdAt,
  };
}

/** A typed error the route layer maps to an HTTP status + code. */
export class MemberActionError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "MemberActionError";
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// CSPRNG temporary password: 16 random bytes (128 bits) as URL-safe base64.
function generateTempPassword(): string {
  return randomBytes(16).toString("base64url");
}

function audit(
  actorUserId: string,
  action: string,
  outcome: "ok" | "rejected",
  fields: { targetUserId?: string; spaceId?: string; role?: string; detail?: string } = {},
) {
  return prisma.auditLog.create({
    data: { actorUserId, action, outcome, ...fields },
  });
}

// --- Read --------------------------------------------------------------------

/** All users with their per-space memberships (admin Members view). */
export async function listMembers(): Promise<MemberWithRoles[]> {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: "asc" },
    include: { memberships: { select: { spaceId: true, role: true } } },
  });
  return users.map((u) => ({ ...toPublicMember(u), memberships: u.memberships }));
}

/** Count of workspace admins + owner — the "root holders" for the invariant. */
export function countWorkspaceAdmins(): Promise<number> {
  return prisma.user.count({ where: { workspaceRole: { in: ["owner", "admin"] } } });
}

// --- Account creation --------------------------------------------------------

export interface CreatedAccount {
  user: PublicMember;
  /** The one-time temp password, returned to the creating admin for out-of-band handoff. */
  tempPassword: string;
}

/**
 * Create a member account with a CSPRNG temp password and a forced first-login
 * change (R9). No session is created (no auto-login). The temp password is
 * returned exactly once.
 */
export async function createAccount(actorUserId: string, email: string): Promise<CreatedAccount> {
  const normalized = normalizeEmail(email);
  if (!normalized.includes("@")) {
    throw new MemberActionError(400, "invalid_email");
  }
  if (await prisma.user.findUnique({ where: { email: normalized } })) {
    throw new MemberActionError(409, "email_taken");
  }
  const tempPassword = generateTempPassword();
  const passwordHash = await argon2.hash(tempPassword);
  const user = await prisma.user.create({
    data: {
      email: normalized,
      passwordHash,
      workspaceRole: "member",
      mustChangePassword: true,
      tempPasswordExpiresAt: new Date(Date.now() + TEMP_PASSWORD_TTL_MS),
    },
  });
  await audit(actorUserId, "account.create", "ok", { targetUserId: user.id });
  return { user: toPublicMember(user), tempPassword };
}

// --- Per-space role grant/change/revoke -------------------------------------

/**
 * Grant or change a user's per-space role (R4). Upserts the Membership; on a
 * change (the row already existed) the target's sessions are dropped so the new
 * role takes effect immediately. Audited as role.grant or role.change.
 */
export async function setRole(
  actorUserId: string,
  targetUserId: string,
  spaceId: string,
  role: string,
): Promise<void> {
  if (!SPACE_ROLES.has(role)) {
    throw new MemberActionError(400, "invalid_role");
  }
  const [target, space] = await Promise.all([
    prisma.user.findUnique({ where: { id: targetUserId } }),
    prisma.space.findUnique({ where: { id: spaceId } }),
  ]);
  if (!target || !space) {
    throw new MemberActionError(404, "not_found");
  }
  const existing = await prisma.membership.findUnique({
    where: { userId_spaceId: { userId: targetUserId, spaceId } },
  });
  await prisma.membership.upsert({
    where: { userId_spaceId: { userId: targetUserId, spaceId } },
    create: { userId: targetUserId, spaceId, role },
    update: { role },
  });
  if (existing) {
    // A role change can be a downgrade; force re-login so it's immediate.
    await dropSessionsForUser(targetUserId);
    await audit(actorUserId, "role.change", "ok", { targetUserId, spaceId, role });
  } else {
    await audit(actorUserId, "role.grant", "ok", { targetUserId, spaceId, role });
  }
}

/**
 * Revoke a user's membership of a space (R4, R8). Deletes the row (no-op if
 * absent) and drops the target's sessions. Audited as role.revoke.
 */
export async function revokeRole(actorUserId: string, targetUserId: string, spaceId: string): Promise<void> {
  await prisma.membership.deleteMany({ where: { userId: targetUserId, spaceId } });
  await dropSessionsForUser(targetUserId);
  await audit(actorUserId, "role.revoke", "ok", { targetUserId, spaceId });
}

// --- Admin promote / demote (owner-only; route enforces the workspace role) --

/** Promote a member to admin (R3). Route restricts the caller to the owner. */
export async function promoteAdmin(actorUserId: string, targetUserId: string): Promise<void> {
  const target = await prisma.user.findUnique({ where: { id: targetUserId } });
  if (!target) {
    throw new MemberActionError(404, "not_found");
  }
  if (target.workspaceRole === "owner") {
    throw new MemberActionError(400, "already_privileged");
  }
  await prisma.user.update({ where: { id: targetUserId }, data: { workspaceRole: "admin" } });
  await audit(actorUserId, "admin.promote", "ok", { targetUserId });
}

/**
 * Demote an admin to member (R3, R5). The owner can never be demoted, and the
 * demotion must not leave the workspace with zero admins/owner. A rejected
 * attempt is audited as outcome=rejected before throwing.
 */
export async function demoteAdmin(actorUserId: string, targetUserId: string): Promise<void> {
  const target = await prisma.user.findUnique({ where: { id: targetUserId } });
  if (!target) {
    throw new MemberActionError(404, "not_found");
  }
  if (target.workspaceRole === "owner") {
    await audit(actorUserId, "admin.demote", "rejected", { targetUserId, detail: "owner is immutable" });
    throw new MemberActionError(403, "owner_immutable");
  }
  if (target.workspaceRole !== "admin") {
    throw new MemberActionError(400, "not_an_admin");
  }
  // Defense in depth: never leave zero root holders (R5). With an undemotable
  // owner this can't trip today, but the guard stays robust to model changes.
  if ((await countWorkspaceAdmins()) <= 1) {
    await audit(actorUserId, "admin.demote", "rejected", { targetUserId, detail: "last admin" });
    throw new MemberActionError(409, "last_admin");
  }
  await prisma.user.update({ where: { id: targetUserId }, data: { workspaceRole: "member" } });
  await dropSessionsForUser(targetUserId);
  await audit(actorUserId, "admin.demote", "ok", { targetUserId });
}

// --- Password reset ----------------------------------------------------------

/**
 * Reset a user's password to a fresh CSPRNG temp password with a forced change
 * (R11). Drops their sessions and returns the temp password once. Memberships
 * and workspace role are untouched.
 */
export async function resetPassword(actorUserId: string, targetUserId: string): Promise<{ tempPassword: string }> {
  const target = await prisma.user.findUnique({ where: { id: targetUserId } });
  if (!target) {
    throw new MemberActionError(404, "not_found");
  }
  const tempPassword = generateTempPassword();
  const passwordHash = await argon2.hash(tempPassword);
  await prisma.user.update({
    where: { id: targetUserId },
    data: {
      passwordHash,
      mustChangePassword: true,
      tempPasswordExpiresAt: new Date(Date.now() + TEMP_PASSWORD_TTL_MS),
    },
  });
  await dropSessionsForUser(targetUserId);
  await audit(actorUserId, "password.reset", "ok", { targetUserId });
  return { tempPassword };
}
