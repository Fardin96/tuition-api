import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { privateNoStore } from "../../lib/admin.js";
import { accountRateLimit } from "../../lib/rate-limit.js";
import { routeDocs } from "../../openapi/docs.js";
import { requireRole } from "../../plugins/auth.js";
import {
  type ApplyPromoInput,
  applyPromoSchema,
  type FeeIdParam,
  type FeeListQuery,
  feeIdParamSchema,
  feeListQuerySchema,
  tutorFeeDetailSchema,
  tutorFeePageSchema,
} from "./fee.schema.js";
import { getMyFee, listMyFees } from "./fee.service.js";
import { applyPromo, removePromo } from "./promo.service.js";

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

  app.post(
    "/:id/promo",
    {
      config: accountRateLimit(10, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Fees",
          summary: "Apply a promo code to a fee",
          description:
            "Applies a promo code to one of my fees. Only a DUE fee with nothing paid and no code yet accepts one. A percentage code takes its share of the amount due (capped if the code has a maximum); a flat code takes its value. A code that covers the whole fee waives it, so nothing is left to pay. A code that would leave less than ৳10 to pay online is refused. A pending online checkout is ended first. Refused while an online payment for the fee is starting. Codes are not case-sensitive.",
          auth: ["TUTOR"],
          errors: [404, 409, 503],
          rateLimit: "10/min per account",
        }),
        params: feeIdParamSchema,
        body: applyPromoSchema,
        response: { 200: tutorFeeDetailSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "TUTOR");
      const { id } = request.params as FeeIdParam;
      const body = request.body as ApplyPromoInput;
      const fee = await applyPromo(account.accountId, id, body.code);
      return reply.send(fee);
    },
  );

  app.delete(
    "/:id/promo",
    {
      config: accountRateLimit(10, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Fees",
          summary: "Remove the promo code from a fee",
          description:
            "Removes the promo code from one of my fees and restores the amount it replaced. Only while the fee is DUE with nothing paid. A code that waived the fee cannot be removed. A pending online checkout is ended first. Refused while an online payment for the fee is starting.",
          auth: ["TUTOR"],
          errors: [404, 409, 503],
          rateLimit: "10/min per account",
        }),
        params: feeIdParamSchema,
        response: { 200: tutorFeeDetailSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "TUTOR");
      const { id } = request.params as FeeIdParam;
      const fee = await removePromo(account.accountId, id);
      return reply.send(fee);
    },
  );
}
