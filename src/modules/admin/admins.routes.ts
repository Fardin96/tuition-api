import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { privateNoStore } from "../../lib/admin.js";
import { accountRateLimit } from "../../lib/rate-limit.js";
import { routeDocs } from "../../openapi/docs.js";
import { requireAdmin, requireSuperAdmin } from "../../plugins/auth.js";
import {
  type AdminAccountIdParam,
  type AdminInviteIdParam,
  adminAccountIdParamSchema,
  adminInviteIdParamSchema,
  adminInviteListSchema,
  adminInviteSchema,
  adminTeamListSchema,
  adminTeamMemberSchema,
  type CreateAdminInvite,
  createAdminInviteSchema,
} from "./admins.schema.js";
import {
  approveAdmin,
  createAdminInvite,
  listAdminInvites,
  listAdminTeam,
  removeAdmin,
  revokeAdminInvite,
} from "./admins.service.js";

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

  app.get(
    "/invites",
    {
      config: accountRateLimit(300, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "List admin invites",
          description:
            "Super admins only. Open invites, newest first, capped at 200. Expired invites stay listed with expired true until they are replaced or revoked.",
          auth: "admin",
          rateLimit: "300/min per account",
        }),
        response: { 200: adminInviteListSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireSuperAdmin(request);
      return reply.send(await listAdminInvites());
    },
  );

  app.post(
    "/invites",
    {
      config: accountRateLimit(60, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "Invite a new admin by email",
          description:
            "Super admins only. The invited Google account becomes an ACTIVE admin on its next sign-in (POST /auth/google, no role). Invites last 14 days. 409 ACCOUNT_EXISTS if the email already has an account, SUPER_ADMIN_EMAIL for a super admin's email, INVITE_EXISTS if an open invite exists (an expired one is replaced).",
          auth: "admin",
          errors: [409],
          rateLimit: "60/min per account",
        }),
        body: createAdminInviteSchema,
        response: { 201: adminInviteSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const caller = await requireSuperAdmin(request);
      const { email } = request.body as CreateAdminInvite;
      return reply.status(201).send(await createAdminInvite(email, caller, request.ip));
    },
  );

  app.delete(
    "/invites/:id",
    {
      config: accountRateLimit(60, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "Revoke an admin invite",
          description: "Super admins only. Deletes the open invite. 404 if it does not exist.",
          auth: "admin",
          errors: [404],
          noContent: true,
          rateLimit: "60/min per account",
        }),
        params: adminInviteIdParamSchema,
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const caller = await requireSuperAdmin(request);
      const { id } = request.params as AdminInviteIdParam;
      await revokeAdminInvite(id, caller, request.ip);
      return reply.status(204).send();
    },
  );
}
