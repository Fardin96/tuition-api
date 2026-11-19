import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { privateNoStore } from "../../lib/admin.js";
import { accountRateLimit } from "../../lib/rate-limit.js";
import { routeDocs } from "../../openapi/docs.js";
import { requireAdmin } from "../../plugins/auth.js";
import {
  type CaseActionInput,
  type CaseIdParam,
  caseActionSchema,
  caseIdParamSchema,
} from "./cases.js";
import {
  type AdminDisputeListQuery,
  adminDisputeDetailSchema,
  adminDisputeListQuerySchema,
  adminDisputePageSchema,
} from "./disputes.schema.js";
import { actOnDispute, getAdminDispute, listAdminDisputes } from "./disputes.service.js";

// Disputes for moderation, mounted at /api/v1/admin/disputes.
export async function adminDisputeRoutes(app: FastifyInstance) {
  privateNoStore(app);

  app.get(
    "/",
    {
      config: accountRateLimit(300, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "List Disputes",
          description:
            "queue defaults to open (OPEN and UNDER_REVIEW, oldest first, the work queue). queue=closed lists RESOLVED and DISMISSED, newest first. Cursor-paginated (limit 1 to 100, default 25).",
          auth: "admin",
          rateLimit: "300/min per account",
        }),
        querystring: adminDisputeListQuerySchema,
        response: { 200: adminDisputePageSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAdmin(request);
      const query = request.query as AdminDisputeListQuery;
      return reply.send(await listAdminDisputes(query));
    },
  );

  app.get(
    "/:id",
    {
      config: accountRateLimit(300, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "Get disputes",
          description: "a dispute",
          auth: "admin",
          errors: [404],
          rateLimit: "300/min per account",
        }),
        params: caseIdParamSchema,
        response: { 200: adminDisputeDetailSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAdmin(request);
      const { id } = request.params as CaseIdParam;
      return reply.send(await getAdminDispute(id));
    },
  );

  app.patch(
    "/:id",
    {
      config: accountRateLimit(60, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "Assign, resolve or dismiss disputes",
          description:
            "ASSIGN moves an OPEN case to UNDER_REVIEW under you (or takes over one held by another admin). RESOLVE and DISMISS close an OPEN or UNDER_REVIEW case and need a note of 3 to 500 characters. 409 INVALID_CASE_STATE on a closed case or when it is already assigned to you.",
          auth: "admin",
          errors: [404, 409],
          rateLimit: "60/min per account",
        }),
        params: caseIdParamSchema,
        body: caseActionSchema,
        response: { 200: adminDisputeDetailSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const admin = await requireAdmin(request);
      const { id } = request.params as CaseIdParam;
      const body = request.body as CaseActionInput;
      return reply.send(await actOnDispute(id, body, admin, request.ip));
    },
  );
}
