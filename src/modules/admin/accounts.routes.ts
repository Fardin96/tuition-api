import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { privateNoStore } from "../../lib/admin.js";
import { accountRateLimit } from "../../lib/rate-limit.js";
import { routeDocs } from "../../openapi/docs.js";
import { requireAdmin } from "../../plugins/auth.js";
import {
  type AccountActionReasonInput,
  type AccountIdParam,
  type AccountListQuery,
  accountActionReasonSchema,
  accountIdParamSchema,
  accountListQuerySchema,
  adminAccountDetailSchema,
  adminAccountPageSchema,
  type BlockAccountInput,
  blockAccountSchema,
} from "./accounts.schema.js";
import {
  blockAccount,
  deactivateAccount,
  getAccountDetail,
  hardDeleteAccountAsAdmin,
  listAccounts,
  unblockAccount,
} from "./accounts.service.js";

export async function adminAccountRoutes(app: FastifyInstance) {
  privateNoStore(app);

  app.get(
    "/",
    {
      config: accountRateLimit(300, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "List accounts",
          description:
            "Newest first. q matches the email, the student or tutor or admin name (case-insensitive), or an exact student or tutor phone number. Cursor-paginated (limit 1 to 100, default 25).",
          auth: "admin",
          rateLimit: "300/min per account",
        }),
        querystring: accountListQuerySchema,
        response: { 200: adminAccountPageSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAdmin(request);
      const query = request.query as AccountListQuery;
      return reply.send(await listAccounts(query));
    },
  );

  app.get(
    "/:id",
    {
      config: accountRateLimit(300, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "Get an account",
          description:
            "Profile summary, consent, the active block, the 20 latest blocks and counts (applications, open requirements, open packages).",
          auth: "admin",
          errors: [404],
          rateLimit: "300/min per account",
        }),
        params: accountIdParamSchema,
        response: { 200: adminAccountDetailSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAdmin(request);
      const { id } = request.params as AccountIdParam;
      return reply.send(await getAccountDetail(id));
    },
  );

  app.post(
    "/:id/block",
    {
      config: accountRateLimit(60, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "Block an account",
          description:
            "Any active admin; an admin account only a super admin (403 otherwise). Revokes the account's open sessions. A super admin, a deleted account or an already blocked account cannot be blocked, and nobody can block themselves.",
          auth: "admin",
          errors: [403, 404, 409],
          rateLimit: "60/min per account",
        }),
        params: accountIdParamSchema,
        body: blockAccountSchema,
        response: { 200: adminAccountDetailSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const caller = await requireAdmin(request);
      const { id } = request.params as AccountIdParam;
      const body = request.body as BlockAccountInput;
      return reply.send(await blockAccount(id, body, caller, request.ip));
    },
  );

  app.post(
    "/:id/unblock",
    {
      config: accountRateLimit(60, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "Unblock an account",
          description:
            "Any active admin; an admin account only a super admin (403 otherwise). Closes the open block. 409 when the account is not blocked.",
          auth: "admin",
          errors: [403, 404, 409],
          rateLimit: "60/min per account",
        }),
        params: accountIdParamSchema,
        response: { 200: adminAccountDetailSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const caller = await requireAdmin(request);
      const { id } = request.params as AccountIdParam;
      return reply.send(await unblockAccount(id, caller, request.ip));
    },
  );

  app.post(
    "/:id/deactivate",
    {
      config: accountRateLimit(30, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "Deactivate an account",
          description:
            "Any active admin; an admin account only a super admin (403 otherwise). The soft delete (as DELETE /me): frees the phone and WhatsApp numbers, closes open requirements and packages, withdraws pending applications, revokes sessions and takes landing cards down. The owner can reactivate by signing up again. A super admin, the caller, a blocked account (unblock first) and an already deactivated account answer 409.",
          auth: "admin",
          errors: [403, 404, 409],
          rateLimit: "30/min per account",
        }),
        params: accountIdParamSchema,
        body: accountActionReasonSchema,
        response: { 200: adminAccountDetailSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const caller = await requireAdmin(request);
      const { id } = request.params as AccountIdParam;
      const body = request.body as AccountActionReasonInput;
      return reply.send(await deactivateAccount(id, body, caller, request.ip));
    },
  );

  app.post(
    "/:id/hard-delete",
    {
      config: accountRateLimit(30, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "Permanently delete an account",
          description:
            "Any active admin; an admin account only a super admin (403 otherwise). The same delete as DELETE /me/hard-delete; it cannot be undone. The reason goes to the audit log. A super admin or the caller answers 409, and so does an account with payment records or (for an admin) audit history, which are kept: block or deactivate it instead.",
          auth: "admin",
          errors: [403, 404, 409],
          rateLimit: "30/min per account",
          noContent: true,
        }),
        params: accountIdParamSchema,
        body: accountActionReasonSchema,
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const caller = await requireAdmin(request);
      const { id } = request.params as AccountIdParam;
      const body = request.body as AccountActionReasonInput;
      await hardDeleteAccountAsAdmin(id, body, caller, request.ip);
      return reply.status(204).send();
    },
  );
}
