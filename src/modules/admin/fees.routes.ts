import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { privateNoStore } from "../../lib/admin.js";
import { accountRateLimit } from "../../lib/rate-limit.js";
import { routeDocs } from "../../openapi/docs.js";
import { requireAdmin } from "../../plugins/auth.js";
import {
  type AdminFeeListQuery,
  adminFeeDetailSchema,
  adminFeeListQuerySchema,
  adminFeePageSchema,
  type CreateFeeInput,
  createFeeSchema,
  type FeeIdParam,
  feeIdParamSchema,
  type PaymentIdParam,
  paymentIdParamSchema,
  type RecordPaymentInput,
  type ReversePaymentInput,
  recordPaymentSchema,
  reversePaymentSchema,
  type UpdateFeeInput,
  updateFeeSchema,
} from "./fees.schema.js";
import {
  createFee,
  getFee,
  listFees,
  recordPayment,
  reversePayment,
  updateFee,
} from "./fees.service.js";

export async function adminFeeRoutes(app: FastifyInstance) {
  privateNoStore(app);

  app.post(
    "/fees",
    {
      config: accountRateLimit(60, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "Add a fee to an application",
          description:
            "Adds a fee to a CONFIRMED or COMPLETED application. The tutor comes from the application. A second PLACEMENT fee is refused while a non-VOID one exists.",
          auth: "admin",
          errors: [404, 409],
          rateLimit: "60/min per account",
        }),
        body: createFeeSchema,
        response: { 201: adminFeeDetailSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const admin = await requireAdmin(request);
      const body = request.body as CreateFeeInput;
      const fee = await createFee(body, admin, request.ip);
      return reply.code(201).send(fee);
    },
  );

  app.get(
    "/fees",
    {
      config: accountRateLimit(300, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "List fees",
          description:
            "Newest first. Filter by status, tutor and overdue (DUE or PARTIAL with a due date before today, Asia/Dhaka). Cursor-paginated (limit 1 to 100, default 25).",
          auth: "admin",
          rateLimit: "300/min per account",
        }),
        querystring: adminFeeListQuerySchema,
        response: { 200: adminFeePageSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAdmin(request);
      const query = request.query as AdminFeeListQuery;
      const result = await listFees(query);
      return reply.send(result);
    },
  );

  app.get(
    "/fees/:id",
    {
      config: accountRateLimit(300, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "Get a fee with its payment ledger",
          auth: "admin",
          errors: [404],
          rateLimit: "300/min per account",
        }),
        params: feeIdParamSchema,
        response: { 200: adminFeeDetailSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      await requireAdmin(request);
      const { id } = request.params as FeeIdParam;
      const fee = await getFee(id);
      return reply.send(fee);
    },
  );

  app.patch(
    "/fees/:id",
    {
      config: accountRateLimit(60, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "Change a fee's due date, note or status",
          description:
            "status WAIVED: only from DUE or PARTIAL. VOID: only with no payments recorded, and never from PAID. A VOID fee cannot be changed.",
          auth: "admin",
          errors: [404, 409],
          rateLimit: "60/min per account",
        }),
        params: feeIdParamSchema,
        body: updateFeeSchema,
        response: { 200: adminFeeDetailSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const admin = await requireAdmin(request);
      const { id } = request.params as FeeIdParam;
      const body = request.body as UpdateFeeInput;
      const fee = await updateFee(id, body, admin, request.ip);
      return reply.send(fee);
    },
  );

  app.post(
    "/fees/:id/payments",
    {
      config: accountRateLimit(60, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "Record a cash payment on a fee",
          description:
            "Appends a PAYMENT row to the ledger. amount_paid and status are recomputed by the database. Refused on PAID, WAIVED or VOID fees and above the amount still due.",
          auth: "admin",
          errors: [404, 409],
          rateLimit: "60/min per account",
        }),
        params: feeIdParamSchema,
        body: recordPaymentSchema,
        response: { 201: adminFeeDetailSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const admin = await requireAdmin(request);
      const { id } = request.params as FeeIdParam;
      const body = request.body as RecordPaymentInput;
      const fee = await recordPayment(id, body, admin, request.ip);
      return reply.code(201).send(fee);
    },
  );

  app.post(
    "/payments/:id/reverse",
    {
      config: accountRateLimit(60, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Admin",
          summary: "Reverse all or part of a payment",
          description:
            "Appends a REVERSAL row pointing at the payment. Payments are never edited or deleted. Refused on waived or void fees. Online (SSLCommerz) payments are refused too: refund them from Refunds, so the gateway returns the money.",
          auth: "admin",
          errors: [404, 409],
          rateLimit: "60/min per account",
        }),
        params: paymentIdParamSchema,
        body: reversePaymentSchema,
        response: { 201: adminFeeDetailSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const admin = await requireAdmin(request);
      const { id } = request.params as PaymentIdParam;
      const body = request.body as ReversePaymentInput;
      const fee = await reversePayment(id, body, admin, request.ip);
      return reply.code(201).send(fee);
    },
  );
}
