import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { privateNoStore } from "../../lib/admin.js";
import { accountRateLimit } from "../../lib/rate-limit.js";
import { routeDocs } from "../../openapi/docs.js";
import { requireRole } from "../../plugins/auth.js";
import {
  type FeeIdParam,
  type FeeListQuery,
  feeIdParamSchema,
  feeListQuerySchema,
  tutorFeeDetailSchema,
  tutorFeePageSchema,
} from "./fee.schema.js";
import { getMyFee, listMyFees } from "./fee.service.js";

// Tutor fee reads: GET /fees/mine and GET /fees/:id. Mounted at /api/v1/fees.
export async function feeRoutes(app: FastifyInstance) {
  privateNoStore(app);

  app.get(
    "/mine",
    {
      config: accountRateLimit(300, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Fees",
          summary: "List my fees",
          description:
            "The signed-in tutor's placement and other fees, newest first. Cursor-paginated, 50 per page: pass nextCursor back as cursor until it is null.",
          auth: ["TUTOR"],
          errors: [404],
          rateLimit: "300/min per account",
        }),
        querystring: feeListQuerySchema,
        response: { 200: tutorFeePageSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "TUTOR");
      const query = request.query as FeeListQuery;
      const page = await listMyFees(account.accountId, query.cursor);
      return reply.send(page);
    },
  );

  app.get(
    "/:id",
    {
      config: accountRateLimit(300, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Fees",
          summary: "Get one of my fees",
          description:
            "One fee with its payments, the online checkout quote (null when nothing can be paid online) and the pending gateway attempt, if any. A fee that belongs to another tutor is 404.",
          auth: ["TUTOR"],
          errors: [404],
          rateLimit: "300/min per account",
        }),
        params: feeIdParamSchema,
        response: { 200: tutorFeeDetailSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "TUTOR");
      const { id } = request.params as FeeIdParam;
      const fee = await getMyFee(account.accountId, id);
      return reply.send(fee);
    },
  );
}
