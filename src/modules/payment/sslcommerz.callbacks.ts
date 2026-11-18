import formbody from "@fastify/formbody";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { env } from "../../config/env.js";
import { privateNoStore } from "../../lib/admin.js";
import { GatewayError, isSuccessStatus } from "../../lib/sslcommerz.js";
import { feeIdOfAttempt, markAttempt, reconcileAttempt, settleAttempt } from "./payment.service.js";

// Callback bodies are form fields from the browser or from SSLCommerz. Only tran_id is required.
// The rest of the body is never used for money, only as lookup keys for the gateway.
const callbackBody = z.looseObject({
  tran_id: z
    .string()
    .min(1)
    .max(30)
    .regex(/^[A-Za-z0-9]+$/),
  val_id: z.string().optional(),
  status: z.string().optional(),
  error: z.string().optional(),
});
type CallbackBody = z.infer<typeof callbackBody>;

const FEES_PATH = "/dashboard/fees";

function parseCallback(body: unknown): CallbackBody | null {
  const result = callbackBody.safeParse(body ?? {});
  return result.success ? result.data : null;
}

// No WEB_PUBLIC_URL: send the browser to "/" rather than fail.
function webUrl(path: string): string {
  const base = env.WEB_PUBLIC_URL?.replace(/\/+$/, "");
  return base ? `${base}${path}` : "/";
}

function feesUrl(): string {
  return webUrl(FEES_PATH);
}

function paymentPageUrl(feeId: string, tranId: string): string {
  return webUrl(`/dashboard/fees/${feeId}/payment?tran=${encodeURIComponent(tranId)}`);
}

// The browser is always sent somewhere. Only a known attempt gets its own page.
function redirectTo(reply: FastifyReply, url: string) {
  return reply.redirect(url, 303);
}

// Browser return from SSLCommerz. Errors are logged, never shown to the browser.
export async function sslcommerzCallbackRoutes(app: FastifyInstance) {
  await app.register(formbody);
  privateNoStore(app);

  app.post("/success", { schema: { hide: true } }, async (request: FastifyRequest, reply) => {
    const body = parseCallback(request.body);
    if (!body) return redirectTo(reply, feesUrl());

    const { tran_id: tranId, val_id: valId } = body;
    let feeId: string | null = null;
    try {
      feeId = await feeIdOfAttempt(tranId);
      if (feeId) {
        if (valId) {
          await settleAttempt(tranId, valId);
        } else {
          await reconcileAttempt(tranId);
        }
      }
    } catch (err) {
      request.log.error(
        { err, tranId },
        "SSLCommerz success callback could not settle the payment",
      );
    }
    return redirectTo(reply, feeId ? paymentPageUrl(feeId, tranId) : feesUrl());
  });

  // Browser return after the customer cancelled or the gateway declined. Soft state only.
  async function endFromBrowser(
    request: FastifyRequest,
    reply: FastifyReply,
    status: "FAILED" | "CANCELLED",
    fallbackReason: string,
  ) {
    const body = parseCallback(request.body);
    if (!body) return redirectTo(reply, feesUrl());

    const tranId = body.tran_id;
    const reason = body.error?.trim().slice(0, 200) || fallbackReason;
    let feeId: string | null = null;
    try {
      feeId = await feeIdOfAttempt(tranId);
      if (feeId) await markAttempt(tranId, status, reason);
    } catch (err) {
      request.log.error({ err, tranId }, "SSLCommerz browser return could not end the payment");
    }
    return redirectTo(reply, feeId ? paymentPageUrl(feeId, tranId) : feesUrl());
  }

  app.post("/fail", { schema: { hide: true } }, async (request: FastifyRequest, reply) =>
    endFromBrowser(request, reply, "FAILED", "Payment failed"),
  );

  app.post("/cancel", { schema: { hide: true } }, async (request: FastifyRequest, reply) =>
    endFromBrowser(request, reply, "CANCELLED", "Payment cancelled"),
  );

  // Server-to-server notification. A 500 makes SSLCommerz retry. Gateway trouble is answered 200,
  // because reconcile will pick the payment up later.
  app.post("/ipn", { schema: { hide: true } }, async (request: FastifyRequest, reply) => {
    const body = parseCallback(request.body);
    if (!body) return reply.send({ received: true });

    const { tran_id: tranId, val_id: valId, status } = body;
    try {
      if (status && isSuccessStatus(status)) {
        if (valId) await settleAttempt(tranId, valId);
      } else if (status === "CANCELLED") {
        await markAttempt(tranId, "CANCELLED", `Gateway status ${status}`);
      } else if (status === "FAILED" || status === "EXPIRED" || status === "UNATTEMPTED") {
        await markAttempt(tranId, "FAILED", `Gateway status ${status}`);
      }
    } catch (err) {
      if (err instanceof GatewayError) {
        request.log.warn({ err, tranId }, "SSLCommerz IPN could not reach the gateway");
        return reply.send({ received: true });
      }
      throw err;
    }
    return reply.send({ received: true });
  });
}
