// Shared auth types + Fastify module augmentation.
// `request.user` is attached by the auth guard once a request carries a valid
// session cookie. It is optional because not every route runs behind the guard
// (auth + static routes are exempt), so consumers must handle `undefined`.

import type { User } from "@prisma/client";

// The authenticated principal exposed on the request. We deliberately omit the
// password hash (and the temp-password expiry) so neither can leak through a
// handler that echoes `request.user`. `workspaceRole` and `mustChangePassword`
// drive authorization (RBAC) and the forced first-login password change.
export type AuthUser = Pick<
  User,
  "id" | "email" | "createdAt" | "workspaceRole" | "mustChangePassword"
>;

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

// Name of the signed session cookie.
export const SESSION_COOKIE = "sid";

// Sessions live for 30 days from creation (sliding expiry is out of scope for v1).
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
