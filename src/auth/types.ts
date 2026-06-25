// Shared auth types + Fastify module augmentation (U3).
// `request.user` is attached by the auth guard once a request carries a valid
// session cookie. It is optional because not every route runs behind the guard
// (auth + static routes are exempt), so consumers must handle `undefined`.

import type { User } from "@prisma/client";

// The authenticated principal exposed on the request. We deliberately omit the
// password hash so it can never leak through a handler that echoes `request.user`.
export type AuthUser = Pick<User, "id" | "email" | "createdAt">;

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

// Name of the signed session cookie.
export const SESSION_COOKIE = "sid";

// Sessions live for 30 days from creation (sliding expiry is out of scope for v1).
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
