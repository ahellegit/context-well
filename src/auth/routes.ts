// Auth routes (U3): POST /register, POST /login, POST /logout, GET /me.
// Mounted by the orchestrator under the /api/auth prefix, *outside* the guarded
// scope, so they are publicly reachable. Login + register are per-route rate
// limited (5/min) via @fastify/rate-limit. Cookies are HttpOnly, SameSite=Lax,
// signed, and Secure-from-config. R1, R2, R29.

import type { FastifyInstance, FastifyReply } from "fastify";
import { config } from "../config.js";
import {
  DuplicateEmailError,
  createSession,
  destroySession,
  isFirstAccount,
  register,
  rotateSession,
  validateSession,
  verifyLogin,
} from "./service.js";
import { SESSION_COOKIE, SESSION_TTL_MS } from "./types.js";

interface Credentials {
  email?: unknown;
  password?: unknown;
}

// Per-route rate limit: 5 attempts/minute/IP on the credential endpoints.
const credentialRateLimit = {
  rateLimit: { max: 5, timeWindow: "1 minute" },
};

// Minimal email shape + non-empty password. Full validation is out of scope for v1;
// the goal is to reject obviously malformed input with 400 rather than 500.
function parseCredentials(body: unknown): { email: string; password: string } | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const { email, password } = body as Credentials;
  if (typeof email !== "string" || typeof password !== "string") {
    return null;
  }
  const trimmed = email.trim();
  if (trimmed.length === 0 || !trimmed.includes("@") || password.length === 0) {
    return null;
  }
  return { email: trimmed, password };
}

function setSessionCookie(reply: FastifyReply, sessionId: string): void {
  reply.setCookie(SESSION_COOKIE, sessionId, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: config.cookieSecure,
    signed: true,
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}

// Read + verify the signed session cookie off an incoming request, returning the
// raw session id or null. Used to rotate/clear the prior session.
function readSessionId(request: { cookies: Record<string, string | undefined>; unsignCookie: (v: string) => { valid: boolean; value: string | null } }): string | null {
  const raw = request.cookies[SESSION_COOKIE];
  if (!raw) {
    return null;
  }
  const unsigned = request.unsignCookie(raw);
  return unsigned.valid ? unsigned.value : null;
}

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  // POST /register — create an account. Bootstrap-then-gated policy (R29):
  // the first account always succeeds; later ones require config.allowRegistration.
  app.post("/register", { config: credentialRateLimit }, async (request, reply) => {
    const creds = parseCredentials(request.body);
    if (!creds) {
      return reply.code(400).send({ error: "invalid_credentials" });
    }

    const first = await isFirstAccount();
    if (!first && !config.allowRegistration) {
      return reply.code(403).send({ error: "registration_disabled" });
    }

    try {
      const user = await register(creds.email, creds.password);
      // Log the new user straight in with a fresh session.
      const sessionId = await createSession(user.id);
      setSessionCookie(reply, sessionId);
      return reply.code(201).send({ user });
    } catch (err) {
      if (err instanceof DuplicateEmailError) {
        return reply.code(409).send({ error: "email_taken" });
      }
      throw err;
    }
  });

  // POST /login — verify credentials and rotate the session id (R: rotate on login).
  app.post("/login", { config: credentialRateLimit }, async (request, reply) => {
    const creds = parseCredentials(request.body);
    if (!creds) {
      return reply.code(400).send({ error: "invalid_credentials" });
    }

    const user = await verifyLogin(creds.email, creds.password);
    if (!user) {
      return reply.code(401).send({ error: "invalid_credentials" });
    }

    // Drop any session the client already presented and mint a new one.
    const priorSessionId = readSessionId(request);
    const sessionId = await rotateSession(user.id, priorSessionId ?? undefined);
    setSessionCookie(reply, sessionId);
    return reply.code(200).send({ user });
  });

  // POST /logout — invalidate the current session and clear the cookie. Idempotent.
  app.post("/logout", async (request, reply) => {
    const sessionId = readSessionId(request);
    if (sessionId) {
      await destroySession(sessionId);
    }
    clearSessionCookie(reply);
    return reply.code(204).send();
  });

  // GET /me — return the authenticated user, or 401 if not logged in. This route
  // is public (it lives in the auth scope), so it does its own session check.
  app.get("/me", async (request, reply) => {
    const sessionId = readSessionId(request);
    const user = sessionId ? await validateSession(sessionId) : null;
    if (!user) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    return reply.code(200).send({ user });
  });
}
