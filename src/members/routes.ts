// Members & account management API. All routes require a workspace admin
// (plugin-level guard); promote/demote additionally require the owner. Mutations
// are rate-limited. Mounted inside the protected scope by the server, so
// requireAuth + requirePasswordChanged already ran.
//
// NOTE: full paths under /api/members; mount without a prefix.

import type { FastifyInstance, FastifyReply } from "fastify";
import { requireWorkspaceRole } from "../auth/space-guard.js";
import {
  MemberActionError,
  createAccount,
  demoteAdmin,
  listMembers,
  promoteAdmin,
  resetPassword,
  revokeRole,
  setRole,
} from "./service.js";

// Rate limit admin mutations to bound abuse / account-creation storms.
const mutationRateLimit = { rateLimit: { max: 20, timeWindow: "1 minute" } };

// Map a thrown MemberActionError to its HTTP status; rethrow anything else.
function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof MemberActionError) {
    return reply.code(err.status).send({ error: err.code });
  }
  throw err;
}

export default async function membersRoutes(app: FastifyInstance): Promise<void> {
  // Every members route requires a workspace admin (owner passes too).
  app.addHook("preHandler", requireWorkspaceRole("admin"));

  // GET /api/members — users with their per-space roles (admin Members view).
  app.get("/api/members", async () => {
    return listMembers();
  });

  // POST /api/members — create an account with a temp password. Returns the
  // one-time temp password to the creating admin.
  app.post("/api/members", { config: mutationRateLimit }, async (request, reply) => {
    const body = (request.body ?? {}) as { email?: unknown };
    if (typeof body.email !== "string" || body.email.trim().length === 0) {
      return reply.code(400).send({ error: "invalid_email" });
    }
    try {
      const created = await createAccount(request.user!.id, body.email);
      return reply.code(201).send(created);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // POST /api/members/:userId/roles — grant or change a per-space role.
  app.post("/api/members/:userId/roles", { config: mutationRateLimit }, async (request, reply) => {
    const { userId } = request.params as { userId: string };
    const body = (request.body ?? {}) as { spaceId?: unknown; role?: unknown };
    if (typeof body.spaceId !== "string" || typeof body.role !== "string") {
      return reply.code(400).send({ error: "invalid_request" });
    }
    try {
      await setRole(request.user!.id, userId, body.spaceId, body.role);
      return reply.code(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // DELETE /api/members/:userId/roles/:spaceId — revoke a per-space role.
  app.delete("/api/members/:userId/roles/:spaceId", { config: mutationRateLimit }, async (request, reply) => {
    const { userId, spaceId } = request.params as { userId: string; spaceId: string };
    try {
      await revokeRole(request.user!.id, userId, spaceId);
      return reply.code(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // POST /api/members/:userId/promote — make a member an admin. Owner only.
  app.post(
    "/api/members/:userId/promote",
    { config: mutationRateLimit, preHandler: requireWorkspaceRole("owner") },
    async (request, reply) => {
      const { userId } = request.params as { userId: string };
      try {
        await promoteAdmin(request.user!.id, userId);
        return reply.code(204).send();
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // POST /api/members/:userId/demote — demote an admin to member. Owner only.
  app.post(
    "/api/members/:userId/demote",
    { config: mutationRateLimit, preHandler: requireWorkspaceRole("owner") },
    async (request, reply) => {
      const { userId } = request.params as { userId: string };
      try {
        await demoteAdmin(request.user!.id, userId);
        return reply.code(204).send();
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // POST /api/members/:userId/reset-password — issue a fresh temp password.
  app.post("/api/members/:userId/reset-password", { config: mutationRateLimit }, async (request, reply) => {
    const { userId } = request.params as { userId: string };
    try {
      const result = await resetPassword(request.user!.id, userId);
      return reply.code(200).send(result);
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
