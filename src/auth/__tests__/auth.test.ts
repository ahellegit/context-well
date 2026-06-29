// Auth integration tests (U3). Spins a real Fastify app wired like src/server.ts
// (signed cookies + per-route rate limiting + auth routes under /api/auth) plus
// one guarded route, and drives it with app.inject. The DB is a throwaway SQLite
// file provisioned by the setupFile. Each test resets the tables for isolation.

import argon2 from "argon2";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyRateLimit from "@fastify/rate-limit";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { config } from "../../config.js";
import { prisma } from "../../db/client.js";
import authRoutes from "../routes.js";
import { registerAuthGuard } from "../guard.js";
import { createSession, register, validateSession } from "../service.js";
import { SESSION_TTL_MS } from "../types.js";

// Build an app that mirrors how the orchestrator wires things: auth routes are
// public, and a separate encapsulated scope holds the guard + a protected route.
async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(fastifyCookie, { secret: config.sessionSecret });
  await app.register(fastifyRateLimit, { global: false });

  await app.register(authRoutes, { prefix: "/api/auth" });

  // Guarded scope (everything else under /api/*).
  await app.register(async (scope) => {
    registerAuthGuard(scope);
    scope.get("/api/protected", async (request) => ({ ok: true, user: request.user }));
  });

  await app.ready();
  return app;
}

// Pull the Set-Cookie value(s) into a Cookie header string for the next request.
function cookieHeader(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const arr = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  return arr.map((c) => String(c).split(";")[0]).join("; ");
}

let app: FastifyInstance;

beforeEach(async () => {
  // Reset state between tests.
  await prisma.session.deleteMany();
  await prisma.user.deleteMany();
  app = await buildTestApp();
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("register → login → session validates", () => {
  it("registers the first account, logs in, and reaches a guarded route", async () => {
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "operator@example.com", password: "hunter2hunter2" },
    });
    expect(reg.statusCode).toBe(201);
    expect(reg.json().user.email).toBe("operator@example.com");
    // No password hash should ever be returned.
    expect(reg.json().user.passwordHash).toBeUndefined();

    // The guarded route is reachable with the cookie set by register.
    const guardedAfterReg = await app.inject({
      method: "GET",
      url: "/api/protected",
      headers: { cookie: cookieHeader(reg) },
    });
    expect(guardedAfterReg.statusCode).toBe(200);
    expect(guardedAfterReg.json().user.email).toBe("operator@example.com");

    // Log in fresh and confirm the new session also passes the guard.
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "operator@example.com", password: "hunter2hunter2" },
    });
    expect(login.statusCode).toBe(200);

    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: cookieHeader(login) },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe("operator@example.com");
  });
});

describe("credential edge cases", () => {
  it("rejects a duplicate email at the service layer (409 path)", async () => {
    // Registration is bootstrap-only, so a duplicate can't arise via the route
    // (the second call 403s first). Exercise the DuplicateEmailError path on the
    // service directly — the admin Members flow (U4) reuses this guard.
    await register("dup@example.com", "password123");
    await expect(register("dup@example.com", "different123")).rejects.toThrow();
  });

  it("rejects a wrong password with 401", async () => {
    await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "user@example.com", password: "correct-horse" },
    });

    const bad = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "user@example.com", password: "wrong-password" },
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error).toBe("invalid_credentials");
  });

  it("rejects malformed credentials with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "not-an-email", password: "" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("session guard", () => {
  it("returns 401 with no session cookie", async () => {
    const res = await app.inject({ method: "GET", url: "/api/protected" });
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 for a forged/unsigned cookie value", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/protected",
      headers: { cookie: "sid=not-a-valid-signed-value" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 for an expired session", async () => {
    const user = await prisma.user.create({
      data: { email: "expired@example.com", passwordHash: "x" },
    });
    // Create a session then force it to be expired in the past.
    const sessionId = await createSession(user.id);
    await prisma.session.update({
      where: { id: sessionId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    expect(await validateSession(sessionId)).toBeNull();

    // And the row is cleaned up opportunistically.
    expect(await prisma.session.findUnique({ where: { id: sessionId } })).toBeNull();
  });

  it("logout invalidates the session", async () => {
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "logout@example.com", password: "password123" },
    });
    const cookie = cookieHeader(reg);

    const logout = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie },
    });
    expect(logout.statusCode).toBe(204);

    // The old cookie no longer authenticates (session row gone).
    const after = await app.inject({
      method: "GET",
      url: "/api/protected",
      headers: { cookie },
    });
    expect(after.statusCode).toBe(401);
  });
});

describe("registration is bootstrap-only (R9)", () => {
  it("creates the first account as the workspace owner and logs it in", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "boot@example.com", password: "password123" },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().user.workspaceRole).toBe("owner");
    expect(first.json().user.mustChangePassword).toBe(false);
    // Secret fields never cross the boundary.
    expect(first.json().user.passwordHash).toBeUndefined();
    expect(first.json().user.tempPasswordExpiresAt).toBeUndefined();
  });

  it("closes /register once any user exists, regardless of config", async () => {
    await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "boot@example.com", password: "password123" },
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "second@example.com", password: "password123" },
    });
    expect(second.statusCode).toBe(403);
    expect(second.json().error).toBe("registration_closed");
  });
});

describe("forced first-login password change (R10)", () => {
  // Create an admin-provisioned-style user with a temp password.
  async function makeTempUser(email: string, password: string, expiresInMs = 60_000) {
    return prisma.user.create({
      data: {
        email,
        passwordHash: await argon2.hash(password),
        workspaceRole: "member",
        mustChangePassword: true,
        tempPasswordExpiresAt: new Date(Date.now() + expiresInMs),
      },
    });
  }

  async function loginCookie(email: string, password: string): Promise<string> {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
    expect(res.statusCode).toBe(200);
    return cookieHeader(res);
  }

  it("blocks protected routes until the temp password is changed, then allows them", async () => {
    await makeTempUser("temp@example.com", "temp-pass-1234");
    const cookie = await loginCookie("temp@example.com", "temp-pass-1234");

    // /me works (public auth scope) and reports the flag.
    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    expect(me.json().user.mustChangePassword).toBe(true);

    // A protected route is blocked with the distinct code.
    const blocked = await app.inject({ method: "GET", url: "/api/protected", headers: { cookie } });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error).toBe("password_change_required");

    // Change the password; the flag clears.
    const changed = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: { cookie },
      payload: { currentPassword: "temp-pass-1234", newPassword: "brand-new-9876" },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().user.mustChangePassword).toBe(false);

    // The same session now reaches the protected route.
    const after = await app.inject({ method: "GET", url: "/api/protected", headers: { cookie } });
    expect(after.statusCode).toBe(200);
  });

  it("rejects a change with the wrong current password and leaves the flag set", async () => {
    await makeTempUser("temp2@example.com", "temp-pass-1234");
    const cookie = await loginCookie("temp2@example.com", "temp-pass-1234");

    const bad = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: { cookie },
      payload: { currentPassword: "wrong-current", newPassword: "brand-new-9876" },
    });
    expect(bad.statusCode).toBe(401);
    const still = await app.inject({ method: "GET", url: "/api/protected", headers: { cookie } });
    expect(still.statusCode).toBe(403);
  });

  it("refuses login with an expired temp password (generic failure)", async () => {
    await makeTempUser("expired-temp@example.com", "temp-pass-1234", -1000);
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "expired-temp@example.com", password: "temp-pass-1234" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("invalid_credentials");
  });
});

describe("session rotation on login", () => {
  it("issues a new session id on login and invalidates the prior one", async () => {
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "rotate@example.com", password: "password123" },
    });
    const firstCookie = cookieHeader(reg);

    // Exactly one session exists after registration.
    expect(await prisma.session.count()).toBe(1);

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "rotate@example.com", password: "password123" },
      headers: { cookie: firstCookie },
    });
    expect(login.statusCode).toBe(200);
    const secondCookie = cookieHeader(login);

    // Still exactly one session (old dropped, new created) and the cookie changed.
    expect(await prisma.session.count()).toBe(1);
    expect(secondCookie).not.toBe(firstCookie);

    // The old cookie no longer authenticates.
    const oldStillWorks = await app.inject({
      method: "GET",
      url: "/api/protected",
      headers: { cookie: firstCookie },
    });
    expect(oldStillWorks.statusCode).toBe(401);

    // The new cookie does.
    const newWorks = await app.inject({
      method: "GET",
      url: "/api/protected",
      headers: { cookie: secondCookie },
    });
    expect(newWorks.statusCode).toBe(200);
  });
});

describe("login rate limiting", () => {
  it("returns 429 after exceeding 5 attempts in the window", async () => {
    const attempt = () =>
      app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "ratelimit@example.com", password: "nope" },
        remoteAddress: "203.0.113.7",
      });

    // First 5 are processed (401 invalid creds); the 6th is rate limited.
    for (let i = 0; i < 5; i++) {
      const res = await attempt();
      expect(res.statusCode).toBe(401);
    }
    const sixth = await attempt();
    expect(sixth.statusCode).toBe(429);
  });
});

// Guard against accidentally retaining SESSION_TTL_MS regressions (30 days).
it("uses a 30-day session TTL", () => {
  expect(SESSION_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
});
