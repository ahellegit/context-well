// Auth service (U3): password hashing, login verification, and server-side
// session lifecycle. Sessions are rows in the `Session` table; the cookie
// carries only the opaque session id (signed by @fastify/cookie). Passwords are
// hashed with argon2id (argon2 defaults). R1, R2, R29.

import argon2 from "argon2";
import { prisma } from "../db/client.js";
import type { AuthUser } from "./types.js";
import { SESSION_TTL_MS } from "./types.js";

// Project the public-safe view of a user (never the password hash or temp-pw
// expiry). Accepts the full Prisma User and picks only the exposable fields.
function toAuthUser(u: {
  id: string;
  email: string;
  createdAt: Date;
  workspaceRole: string;
  mustChangePassword: boolean;
}): AuthUser {
  return {
    id: u.id,
    email: u.email,
    createdAt: u.createdAt,
    workspaceRole: u.workspaceRole,
    mustChangePassword: u.mustChangePassword,
  };
}

// Normalize emails so "A@b.com" and "a@b.com " are the same account.
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export class DuplicateEmailError extends Error {
  constructor() {
    super("An account with that email already exists");
    this.name = "DuplicateEmailError";
  }
}

/** True when no users exist yet — the first registration bootstraps the operator (R29). */
export async function isFirstAccount(): Promise<boolean> {
  const count = await prisma.user.count();
  return count === 0;
}

/**
 * Register the bootstrap account. Hashes the password with argon2 and persists
 * the user as the workspace `owner` (the first and only account this path
 * creates — the route is bootstrap-only; later accounts come from the admin
 * Members flow). Throws {@link DuplicateEmailError} if the email is taken.
 */
export async function register(email: string, password: string): Promise<AuthUser> {
  const normalized = normalizeEmail(email);
  const existing = await prisma.user.findUnique({ where: { email: normalized } });
  if (existing) {
    throw new DuplicateEmailError();
  }
  // The first account ever created is the workspace owner (R1). Defensive
  // fallback to "member" should this ever be reached with users present.
  const workspaceRole = (await prisma.user.count()) === 0 ? "owner" : "member";
  const passwordHash = await argon2.hash(password);
  const user = await prisma.user.create({
    data: { email: normalized, passwordHash, workspaceRole },
  });
  return toAuthUser(user);
}

/**
 * Verify email + password. Returns the user on success, or `null` on either an
 * unknown email or a wrong password — the caller must not distinguish the two
 * (avoids account enumeration).
 */
export async function verifyLogin(email: string, password: string): Promise<AuthUser | null> {
  const normalized = normalizeEmail(email);
  const user = await prisma.user.findUnique({ where: { email: normalized } });
  if (!user) {
    return null;
  }
  let ok = false;
  try {
    ok = await argon2.verify(user.passwordHash, password);
  } catch {
    // A malformed/legacy hash should read as "wrong password", not a 500.
    ok = false;
  }
  if (!ok) {
    return null;
  }
  // An expired temporary password is dead: the account needs an admin reset.
  // Surface it as a generic failure (no enumeration of "expired vs wrong").
  if (user.tempPasswordExpiresAt && user.tempPasswordExpiresAt.getTime() <= Date.now()) {
    return null;
  }
  return toAuthUser(user);
}

export class PasswordChangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PasswordChangeError";
  }
}

/**
 * Change a user's password (used for the forced first-login change and ordinary
 * changes). Verifies the current password, then sets the new hash and clears the
 * temp-password flags in one update. Returns the refreshed public user, or
 * `null` if the current password does not verify.
 */
export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<AuthUser | null> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    return null;
  }
  let ok = false;
  try {
    ok = await argon2.verify(user.passwordHash, currentPassword);
  } catch {
    ok = false;
  }
  if (!ok) {
    return null;
  }
  const passwordHash = await argon2.hash(newPassword);
  const updated = await prisma.user.update({
    where: { id: userId },
    data: { passwordHash, mustChangePassword: false, tempPasswordExpiresAt: null },
  });
  return toAuthUser(updated);
}

/**
 * Create a fresh session row for a user and return the session id to put in the
 * cookie. Caller is responsible for rotating (dropping the old session) on login.
 */
export async function createSession(userId: string): Promise<string> {
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const session = await prisma.session.create({
    data: { userId, expiresAt },
  });
  return session.id;
}

/**
 * Rotate the session on login: create a new session and delete the old one (if
 * any) in a single transaction so a crash can't leave the user with two valid
 * sessions or none. Returns the new session id.
 */
export async function rotateSession(userId: string, oldSessionId?: string): Promise<string> {
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const [, session] = await prisma.$transaction([
    // deleteMany (not delete) so a missing/expired old id is a no-op, not a throw.
    prisma.session.deleteMany({ where: oldSessionId ? { id: oldSessionId } : { id: "__none__" } }),
    prisma.session.create({ data: { userId, expiresAt } }),
  ]);
  return session.id;
}

/**
 * Resolve a session id to its user, or `null` if the session is missing or
 * expired. Expired sessions are deleted opportunistically.
 */
export async function validateSession(sessionId: string | undefined | null): Promise<AuthUser | null> {
  if (!sessionId) {
    return null;
  }
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: { user: true },
  });
  if (!session) {
    return null;
  }
  if (session.expiresAt.getTime() <= Date.now()) {
    // Best-effort cleanup; ignore races where it's already gone.
    await prisma.session.deleteMany({ where: { id: sessionId } });
    return null;
  }
  return toAuthUser(session.user);
}

/** Invalidate a session (logout). Safe to call with an unknown/expired id. */
export async function destroySession(sessionId: string | undefined | null): Promise<void> {
  if (!sessionId) {
    return;
  }
  await prisma.session.deleteMany({ where: { id: sessionId } });
}
