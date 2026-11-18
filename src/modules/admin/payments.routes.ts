import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { privateNoStore } from "../../lib/admin.js";
import { accountRateLimit } from "../../lib/rate-limit.js";
import { routeDocs } from "../../openapi/docs.js";
import { requireAdmin, requireSuperAdmin } from "../../plugins/auth.js";
import {
  type AdminPaymentListQuery,
  adminPaymentAttemptDetailSchema,
  adminPaymentAttemptPageSchema,
  adminPaymentListQuerySchema,
  adminPaymentSummarySchema,
  type ReviewPaymentInput,
  reviewPaymentSchema,
  type TranIdParam,
  tranIdParamSchema,
} from "./payments.schema.js";
import {
  checkPaymentAttempt,
  getPaymentAttempt,
  listPaymentAttempts,
  paymentAttemptSummary,
  reviewPaymentAttempt,
} from "./payments.service.js";

// Gateway payment attempts for admins, mounted at /api/v1/admin. The ledger reversal stays at
// /admin/payments/:id/reverse (fees.routes.ts).
export async function adminPaymentRoutes(app: FastifyInstance) {
  privateNoStore(app);

  app.get(
    "/payment-attempts",
    {
      config: accountRateLimit(300, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "List online payment attempts",
          description:
            "Newest first. Filter by status, attention (REVIEW or UNAPPLIED), fee and tutor. Cursor-paginated (limit 1 to 100, default 25).",
          auth: "admin",
          rateLimit: "300/min per account",
        }),
        querystring: adminPaymentListQuerySchema,
        response: { 200: adminPaymentAttemptPageSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAdmin(request);
      const query = request.query as AdminPaymentListQuery;
      const result = await listPaymentAttempts(query);
      return reply.send(result);
    },
  );

  // Registered before /payment-attempts/:tranId so "summary" is never read as a tran_id.
  app.get(
    "/payment-attempts/summary",
    {
      config: accountRateLimit(300, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "Count payment attempts that need attention",
          description:
            "Counts of REVIEW and UNAPPLIED attempts, PENDING attempts older than 60 minutes, and SUCCEEDED attempts settled in the last 24 hours with the fee amount collected.",
          auth: "admin",
          rateLimit: "300/min per account",
        }),
        response: { 200: adminPaymentSummarySchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAdmin(request);
      const summary = await paymentAttemptSummary();
      return reply.send(summary);
    },
  );

  app.get(
    "/payment-attempts/:tranId",
    {
      config: accountRateLimit(300, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "Get one online payment attempt",
          description:
            "Amounts, gateway fields, the raw gateway response, the fee and the tutor. canCheck and canReview say which actions the attempt allows right now.",
          auth: "admin",
          errors: [404],
          rateLimit: "300/min per account",
        }),
        params: tranIdParamSchema,
        response: { 200: adminPaymentAttemptDetailSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAdmin(request);
      const { tranId } = request.params as TranIdParam;
      const attempt = await getPaymentAttempt(tranId);
      return reply.send(attempt);
    },
  );

  app.post(
    "/payment-attempts/:tranId/check",
    {
      config: accountRateLimit(30, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "Check a payment attempt with the gateway",
          description:
            "Asks the gateway about a PENDING, FAILED, CANCELLED or EXPIRED attempt and settles it if the gateway has verified a success. Final attempts (SUCCEEDED, REVIEW, UNAPPLIED) are refused. Writes a payment.check audit row. A gateway that does not answer returns 503 and the status is left as it was.",
          auth: "admin",
          errors: [404, 409, 503],
          rateLimit: "30/min per account",
        }),
        params: tranIdParamSchema,
        response: { 200: adminPaymentAttemptDetailSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const admin = await requireAdmin(request);
      const { tranId } = request.params as TranIdParam;
      const attempt = await checkPaymentAttempt(tranId, admin, request.ip);
      return reply.send(attempt);
    },
  );

  app.post(
    "/payment-attempts/:tranId/review",
    {
      config: accountRateLimit(30, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "Approve or reject a flagged payment",
          description:
            "Super admins only. Decides an attempt in REVIEW. APPROVE posts the fee amount to the ledger, unless the ledger refuses it (the attempt becomes UNAPPLIED). REJECT makes it UNAPPLIED and leaves the money with the gateway. Writes a payment.review audit row.",
          auth: "admin",
          errors: [404, 409],
          rateLimit: "30/min per account",
        }),
        params: tranIdParamSchema,
        body: reviewPaymentSchema,
        response: { 200: adminPaymentAttemptDetailSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const admin = await requireSuperAdmin(request);
      const { tranId } = request.params as TranIdParam;
      const body = request.body as ReviewPaymentInput;
      const attempt = await reviewPaymentAttempt(tranId, body, admin, request.ip);
      return reply.send(attempt);
    },
  );
}
