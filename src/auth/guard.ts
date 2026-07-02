// Auth guard: a Fastify preHandler that authenticates a request from its
// signed session cookie and attaches the user to `request.user`, or rejects with
// 401. The orchestrator applies this to `/api/*` except the auth + static routes;
// here we just export the guard and a small helper that scopes it correctly.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { validateSession } from "./service.js";
import { SESSION_COOKIE } from "./types.js";

/**
 * preHandler that requires a valid session. Reads the signed `sid` cookie,
 * verifies the signature, resolves the session, and attaches `request.user`.
 * Replies 401 (and stops the chain) on any failure: no cookie, bad signature,
 * or missing/expired session.
 */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const raw = request.cookies[SESSION_COOKIE];
  if (!raw) {
    await reply.code(401).send({ error: "unauthorized" });
    return;
  }

  // The cookie is signed; reject a tampered/forged value.
  const unsigned = request.unsignCookie(raw);
  if (!unsigned.valid || unsigned.value === null) {
    await reply.code(401).send({ error: "unauthorized" });
    return;
  }

  const user = await validateSession(unsigned.value);
  if (!user) {
    await reply.code(401).send({ error: "unauthorized" });
    return;
  }

  request.user = user;
}

/**
 * preHandler that blocks a user who must still change a temporary password from
 * reaching any protected route. Runs after {@link requireAuth}, so
 * `request.user` is set. The change-password / logout / me endpoints live in the
 * public auth scope (not behind this gate), so the user can still rotate their
 * password and recover. 403s with a distinct code the client routes on.
 */
export async function requirePasswordChanged(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (request.user?.mustChangePassword) {
    await reply.code(403).send({ error: "password_change_required" });
  }
}

/**
 * Register {@link requireAuth} (then {@link requirePasswordChanged}) as guards on
 * the given Fastify instance (intended to be an encapsulated scope, e.g. a plugin
 * that has the protected `/api/*` routes registered under it). Auth routes and
 * static assets must live *outside* this scope so they stay public. The
 * orchestrator owns that wiring.
 */
export function registerAuthGuard(app: FastifyInstance): void {
  app.addHook("preHandler", requireAuth);
  app.addHook("preHandler", requirePasswordChanged);
}
