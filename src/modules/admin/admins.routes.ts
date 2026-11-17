import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { privateNoStore } from "../../lib/admin.js";
import { accountRateLimit } from "../../lib/rate-limit.js";
import { routeDocs } from "../../openapi/docs.js";
import { requireAdmin, requireSuperAdmin } from "../../plugins/auth.js";
import {
  type AdminAccountIdParam,
  adminAccountIdParamSchema,
  adminTeamListSchema,
  adminTeamMemberSchema,
} from "./admins.schema.js";
import { approveAdmin, listAdminTeam, removeAdmin } from "./admins.service.js";

export async function adminTeamRoutes(app: FastifyInstance) {
  privateNoStore(app);

  app.get(
    "/",
    {
      config: accountRateLimit(300, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "List the admin team",
          description:
            "PENDING first, then ACTIVE, then REMOVED; oldest first inside each group. Capped at 200.",
          auth: "admin",
          rateLimit: "300/min per account",
        }),
        response: { 200: adminTeamListSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAdmin(request);
      return reply.send(await listAdminTeam());
    },
  );

  app.post(
    "/:accountId/approve",
    {
      config: accountRateLimit(60, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "Approve a pending admin",
          description:
            "Super admins only. Only PENDING admins whose account is ACTIVE can be approved. 409 InvalidAdminState otherwise.",
          auth: "admin",
          errors: [404, 409],
          rateLimit: "60/min per account",
        }),
        params: adminAccountIdParamSchema,
        response: { 200: adminTeamMemberSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const caller = await requireSuperAdmin(request);
      const { accountId } = request.params as AdminAccountIdParam;
      return reply.send(await approveAdmin(accountId, caller, request.ip));
    },
  );

  app.post(
    "/:accountId/remove",
    {
      config: accountRateLimit(60, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "Remove an admin",
          description:
            "Super admins only. Allowed from PENDING or ACTIVE. Revokes all of the admin's open sessions. A super admin cannot be removed, and nobody can remove themselves.",
          auth: "admin",
          errors: [404, 409],
          rateLimit: "60/min per account",
        }),
        params: adminAccountIdParamSchema,
        response: { 200: adminTeamMemberSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const caller = await requireSuperAdmin(request);
      const { accountId } = request.params as AdminAccountIdParam;
      return reply.send(await removeAdmin(accountId, caller, request.ip));
    },
  );
}
