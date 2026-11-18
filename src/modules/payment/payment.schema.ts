import { z } from "zod";
import { FeeStatus, PaymentAttemptStatus } from "../../generated/prisma/enums.js";

// Our tran_id is 1..30 characters, letters and digits only (SSLCommerz rule).
const tranIdSchema = z.string().regex(/^[A-Za-z0-9]{1,30}$/);

export const paymentFeeParamSchema = z.object({ id: z.string().uuid() });
export type PaymentFeeParam = z.infer<typeof paymentFeeParamSchema>;

export const paymentAttemptParamSchema = z.object({
  id: z.string().uuid(),
  tranId: tranIdSchema,
});
export type PaymentAttemptParam = z.infer<typeof paymentAttemptParamSchema>;

// Money is always a 2-decimal string, for example "1537.50".
export const checkoutSessionSchema = z
  .object({
    tranId: z.string(),
    gatewayUrl: z.string(),
    feeAmount: z.string(),
    chargeAmount: z.string(),
    totalAmount: z.string(),
  })
  .meta({ id: "CheckoutSession" });
export type CheckoutSession = z.infer<typeof checkoutSessionSchema>;

export const paymentAttemptViewSchema = z
  .object({
    tranId: z.string(),
    status: z.nativeEnum(PaymentAttemptStatus),
    feeAmount: z.string(),
    chargeAmount: z.string(),
    totalAmount: z.string(),
    failureReason: z.string().nullable(),
    createdAt: z.date(),
    settledAt: z.date().nullable(),
    fee: z.object({
      status: z.nativeEnum(FeeStatus),
      amountDue: z.string(),
      amountPaid: z.string(),
      remaining: z.string(),
    }),
  })
  .meta({ id: "PaymentAttemptView" });
export type PaymentAttemptView = z.infer<typeof paymentAttemptViewSchema>;
