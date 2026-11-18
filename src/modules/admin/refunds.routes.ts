import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { privateNoStore } from "../../lib/admin.js";
import { accountRateLimit } from "../../lib/rate-limit.js";
import { routeDocs } from "../../openapi/docs.js";
import { requireAdmin, requireSuperAdmin } from "../../plugins/auth.js";
import {
  type AdminRefundDetailResponse,
  adminRefundDetailSchema,
} from "../refunds/refund.schema.js";
import {
  approveRefund,
  checkRefund,
  createAdminRefund,
  getRefund,
  listRefunds,
  rejectRefund,
  resolveRefund,
} from "../refunds/refund.service.js";
import {
  type ApproveRefundBody,
  adminRefundPageSchema,
  approveRefundSchema,
  type CreateRefundBody,
  createRefundSchema,
  type RefundIdParam,
  type RefundListQuery,
  type RejectRefundBody,
  type ResolveRefundBody,
  refundIdParamSchema,
  refundListQuerySchema,
  rejectRefundSchema,
  resolveRefundSchema,
} from "./refunds.schema.js";

// Refunds of SSLCommerz payments, mounted at /api/v1/admin.
export async function adminRefundRoutes(app: FastifyInstance) {
  privateNoStore(app);

  app.get(
    "/refunds",
    {
      config: accountRateLimit(300, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "List refunds",
          description:
            "Newest first. Filter by status, open (true: REQUESTED, PROCESSING or NEEDS_REVIEW; false: the rest) and fee. Cursor-paginated (limit 1 to 100, default 25).",
          auth: "admin",
          rateLimit: "300/min per account",
        }),
        querystring: refundListQuerySchema,
        response: { 200: adminRefundPageSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAdmin(request);
      const query = request.query as RefundListQuery;
      const result = await listRefunds(query);
      return reply.send(result);
    },
  );

  app.get(
    "/refunds/:id",
    {
      config: accountRateLimit(300, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "Get one refund",
          description:
            "Amounts, status, the payment and fee it belongs to, the raw gateway response and the actions allowed right now (canApprove, canReject, canCheck, canResolve).",
          auth: "admin",
          errors: [404],
          rateLimit: "300/min per account",
        }),
        params: refundIdParamSchema,
        response: { 200: adminRefundDetailSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAdmin(request);
      const { id } = request.params as RefundIdParam;
      const refund = await getRefund(id);
      return reply.send(refund);
    },
  );

  app.post(
    "/refunds",
    {
      config: accountRateLimit(30, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "Refund an online payment",
          description:
            "Super admins only. Refunds the fee part of an SSLCommerz payment the gateway took (SUCCEEDED, or UNAPPLIED with a bank transaction id). Without an amount the whole refundable part is refunded. The refund is sent to the gateway straight away and is PROCESSING, SUCCEEDED, FAILED or NEEDS_REVIEW when the response comes back. Writes a refund.create audit row. 409 REFUND_NOT_ALLOWED when the payment cannot be refunded.",
          auth: "admin",
          errors: [404, 409, 503],
          rateLimit: "30/min per account",
        }),
        body: createRefundSchema,
        response: { 201: adminRefundDetailSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const admin = await requireSuperAdmin(request);
      const body = request.body as CreateRefundBody;
      const created: AdminRefundDetailResponse = await createAdminRefund(body, admin, request.ip);
      return reply.code(201).send(created);
    },
  );

  app.post(
    "/refunds/:id/approve",
    {
      config: accountRateLimit(30, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "Approve a tutor's refund request",
          description:
            "Super admins only. Only a REQUESTED refund can be approved. It is sent to the gateway straight away, and the response is PROCESSING, FAILED or NEEDS_REVIEW. Writes a refund.approve audit row.",
          auth: "admin",
          errors: [404, 409, 503],
          rateLimit: "30/min per account",
        }),
        params: refundIdParamSchema,
        // Fastify hands a missing body over as null, so the body may be absent.
        body: approveRefundSchema.nullish(),
        response: { 200: adminRefundDetailSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const admin = await requireSuperAdmin(request);
      const { id } = request.params as RefundIdParam;
      const body = request.body as ApproveRefundBody | null;
      const refund = await approveRefund(id, body?.note, admin, request.ip);
      return reply.send(refund);
    },
  );

  app.post(
    "/refunds/:id/reject",
    {
      config: accountRateLimit(30, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "Decline a tutor's refund request",
          description:
            "Super admins only. Only a REQUESTED refund can be declined. Nothing is sent to the gateway. Writes a refund.reject audit row.",
          auth: "admin",
          errors: [404, 409],
          rateLimit: "30/min per account",
        }),
        params: refundIdParamSchema,
        body: rejectRefundSchema,
        response: { 200: adminRefundDetailSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const admin = await requireSuperAdmin(request);
      const { id } = request.params as RefundIdParam;
      const body = request.body as RejectRefundBody;
      const refund = await rejectRefund(id, body.note, admin, request.ip);
      return reply.send(refund);
    },
  );

  app.post(
    "/refunds/:id/check",
    {
      config: accountRateLimit(30, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "Check a refund with the gateway",
          description:
            "Asks the gateway about a PROCESSING refund and completes it when the gateway says it was refunded (a REVERSAL is written when the payment was on the ledger) or ends it when the gateway cancelled it. Only PROCESSING refunds with a gateway reference can be checked. Writes a refund.check audit row. A gateway that does not answer returns 503 and the refund is left as it was.",
          auth: "admin",
          errors: [404, 409, 503],
          rateLimit: "30/min per account",
        }),
        params: refundIdParamSchema,
        response: { 200: adminRefundDetailSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const admin = await requireAdmin(request);
      const { id } = request.params as RefundIdParam;
      await checkRefund(id, admin);
      return reply.send(await getRefund(id));
    },
  );

  app.post(
    "/refunds/:id/resolve",
    {
      config: accountRateLimit(30, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "Resolve a refund that needs review",
          description:
            "Super admins only. For a NEEDS_REVIEW refund, decided by hand after checking the merchant panel. SUCCEEDED completes it (a REVERSAL is written when the payment was on the ledger; refundRefId is optional and only allowed here). FAILED ends it with the note as the failure reason. Writes a refund.resolve audit row.",
          auth: "admin",
          errors: [404, 409],
          rateLimit: "30/min per account",
        }),
        params: refundIdParamSchema,
        body: resolveRefundSchema,
        response: { 200: adminRefundDetailSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const admin = await requireSuperAdmin(request);
      const { id } = request.params as RefundIdParam;
      const body = request.body as ResolveRefundBody;
      const refund = await resolveRefund(id, body, admin, request.ip);
      return reply.send(refund);
    },
  );
}
