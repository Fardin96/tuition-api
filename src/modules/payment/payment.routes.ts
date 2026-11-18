import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { privateNoStore } from "../../lib/admin.js";
import { accountRateLimit } from "../../lib/rate-limit.js";
import { routeDocs } from "../../openapi/docs.js";
import { requireRole } from "../../plugins/auth.js";
import {
  checkoutSessionSchema,
  type PaymentAttemptParam,
  type PaymentFeeParam,
  paymentAttemptParamSchema,
  paymentAttemptViewSchema,
  paymentFeeParamSchema,
} from "./payment.schema.js";
import { getAttemptView, startCheckout } from "./payment.service.js";

// Tutor checkout for a placement fee, mounted at /api/v1/fees.
export async function paymentRoutes(app: FastifyInstance) {
  privateNoStore(app);

  app.post(
    "/:id/checkout",
    {
      config: accountRateLimit(10, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Fees",
          summary: "Start an online payment for a fee",
          description:
            "Opens an SSLCommerz checkout for the fee's remaining amount, plus the gateway charge when the platform sets one. Returns the gateway page to send the tutor to. Only one checkout can be in progress per fee. A checkout still in progress is checked with the gateway first. A fee that the gateway already paid is refused. The amounts are computed on the server.",
          auth: ["TUTOR"],
          errors: [404, 409, 503],
          rateLimit: "10/min per account",
        }),
        params: paymentFeeParamSchema,
        response: { 201: checkoutSessionSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "TUTOR");
      const { id } = request.params as PaymentFeeParam;
      const session = await startCheckout(account.accountId, id);
      return reply.code(201).send(session);
    },
  );

  app.get(
    "/:id/attempts/:tranId",
    {
      config: accountRateLimit(60, "1 minute"),
      schema: {
        ...routeDocs({
          tag: "Fees",
          summary: "Get the status of an online payment",
          description:
            "Returns one checkout of this fee and the fee's current balance. A payment still PENDING after a few seconds is checked with the gateway first. If the gateway is unreachable, the current status is returned.",
          auth: ["TUTOR"],
          errors: [404],
          rateLimit: "60/min per account",
        }),
        params: paymentAttemptParamSchema,
        response: { 200: paymentAttemptViewSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const account = requireRole(request, "TUTOR");
      const { id, tranId } = request.params as PaymentAttemptParam;
      const view = await getAttemptView(account.accountId, id, tranId, request.log);
      return reply.send(view);
    },
  );
}
