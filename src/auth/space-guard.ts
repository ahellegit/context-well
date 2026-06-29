// Authorization layer (U3). Per-space role guards plus a workspace-role guard,
// applied as Fastify route-level preHandlers *after* the scope's requireAuth
// hook (so `request.user` is set). Enforcement here is the only barrier between
// editors/viewers in the app-layer design — a space-scoped route without one of
// these guards is a confidentiality bug (see the plan's accepted-risk note).
//
// Default-deny with no existence oracle: a route param that resolves to no
// space, a space the caller has no membership for, and an insufficient role all
// return the SAME 403, so a non-member cannot tell whether a resource in another
// space exists.

import type { FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "../db/client.js";

// Per-space roles, ranked. editor outranks viewer.
const SPACE_RANK: Record<string, number> = { viewer: 1, editor: 2 };
export type SpaceRoleMin = "viewer" | "editor";

function meetsSpaceRole(role: string, min: SpaceRoleMin): boolean {
  return (SPACE_RANK[role] ?? 0) >= SPACE_RANK[min];
}

// Workspace admins/owners pass every per-space guard (they manage all spaces).
function isWorkspaceAdmin(role: string | undefined): boolean {
  return role === "owner" || role === "admin";
}

/** Resolves the target space id for a request from its route shape. */
export type SpaceResolver = (request: FastifyRequest) => Promise<string | null>;

/** `:id` is the space id (spaces/uploads routes). */
export const spaceFromParam: SpaceResolver = async (request) => {
  const { id } = (request.params ?? {}) as { id?: string };
  return id ?? null;
};

/** `:id` is a connector id; resolve its owning space. */
export const spaceFromConnector: SpaceResolver = async (request) => {
  const { id } = (request.params ?? {}) as { id?: string };
  if (!id) return null;
  const c = await prisma.connector.findUnique({ where: { id }, select: { spaceId: true } });
  return c?.spaceId ?? null;
};

/** `:id` is a conversation id; resolve its owning space. */
export const spaceFromConversation: SpaceResolver = async (request) => {
  const { id } = (request.params ?? {}) as { id?: string };
  if (!id) return null;
  const c = await prisma.conversation.findUnique({ where: { id }, select: { spaceId: true } });
  return c?.spaceId ?? null;
};

/**
 * preHandler factory: require at least `min` on the space the `resolve` function
 * points at. Workspace admins/owners pass unconditionally; everyone else needs a
 * Membership meeting the rank. 403s (default-deny) on any miss with no oracle.
 */
export function requireSpaceRole(min: SpaceRoleMin, resolve: SpaceResolver) {
  return async function spaceRoleGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const user = request.user;
    if (!user) {
      await reply.code(401).send({ error: "unauthorized" });
      return;
    }
    if (isWorkspaceAdmin(user.workspaceRole)) {
      return; // admins/owners reach every space
    }
    const spaceId = await resolve(request);
    if (!spaceId) {
      await reply.code(403).send({ error: "forbidden" });
      return;
    }
    const membership = await prisma.membership.findUnique({
      where: { userId_spaceId: { userId: user.id, spaceId } },
      select: { role: true },
    });
    if (!membership || !meetsSpaceRole(membership.role, min)) {
      await reply.code(403).send({ error: "forbidden" });
    }
  };
}

/**
 * preHandler factory: require a workspace-level role. "admin" passes for both
 * admin and owner; "owner" passes only for the owner. For routes that are not
 * space-scoped (space create/delete, members management).
 */
export function requireWorkspaceRole(min: "admin" | "owner") {
  return async function workspaceRoleGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const role = request.user?.workspaceRole;
    const ok = min === "owner" ? role === "owner" : isWorkspaceAdmin(role);
    if (!ok) {
      await reply.code(403).send({ error: "forbidden" });
    }
  };
}
