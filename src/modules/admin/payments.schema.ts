import { z } from "zod";
import { FeeStatus, PaymentAttemptStatus } from "../../generated/prisma/enums.js";
import { adminRefundSchema } from "../refunds/refund.schema.js";

// Money is always a 2-decimal string, for example "1537.50".
export const adminPaymentAttemptSchema = z
  .object({
    id: z.string(),
    tranId: z.string(),
    status: z.nativeEnum(PaymentAttemptStatus),
    feeAmount: z.string(),
    chargeAmount: z.string(),
    totalAmount: z.string(),
    failureReason: z.string().nullable(),
    valId: z.string().nullable(),
    bankTranId: z.string().nullable(),
    cardType: z.string().nullable(),
    riskLevel: z.number().int().nullable(),
    paymentId: z.string().nullable(),
    createdAt: z.date(),
    updatedAt: z.date(),
    lastCheckedAt: z.date().nullable(),
    settledAt: z.date().nullable(),
    fee: z.object({
      id: z.string(),
      status: z.nativeEnum(FeeStatus),
      amountDue: z.string(),
      amountPaid: z.string(),
    }),
    tutor: z.object({ id: z.string(), name: z.string() }),
  })
  .meta({ id: "AdminPaymentAttempt" });
export type AdminPaymentAttemptResponse = z.infer<typeof adminPaymentAttemptSchema>;

export const adminPaymentAttemptDetailSchema = adminPaymentAttemptSchema
  .extend({
    /** The raw gateway payload from the last validate. null when none is stored or it is not an object. */
    gatewayResponse: z.record(z.string(), z.unknown()).nullable(),
    /** Status is still settlable and the gateway is configured. */
    canCheck: z.boolean(),
    /** Status is REVIEW: a super admin can approve or reject it. */
    canReview: z.boolean(),
    /** Fee part still refundable: SUCCEEDED or UNAPPLIED with a bank id, else "0.00". */
    refundable: z.string(),
    /** Refunds of this attempt, newest first. */
    refunds: z.array(adminRefundSchema),
  })
  .meta({ id: "AdminPaymentAttemptDetail" });
export type AdminPaymentAttemptDetailResponse = z.infer<typeof adminPaymentAttemptDetailSchema>;

export const adminPaymentAttemptPageSchema = z
  .object({
    attempts: z.array(adminPaymentAttemptSchema),
    nextCursor: z.string().nullable(),
  })
  .meta({ id: "AdminPaymentAttemptPage" });

export const adminPaymentSummarySchema = z
  .object({
    /** REVIEW: the gateway said paid, but something did not match. */
    review: z.number().int(),
    /** UNAPPLIED: the gateway took the money, the ledger refused it. */
    unapplied: z.number().int(),
    /** PENDING and older than 60 minutes. */
    stalePending: z.number().int(),
    /** SUCCEEDED with settledAt in the last 24 hours. */
    succeeded24h: z.number().int(),
    /** Sum of fee_amount of those SUCCEEDED attempts. "0.00" when none. */
    collected24h: z.string(),
  })
  .meta({ id: "AdminPaymentSummary" });
export type AdminPaymentSummaryResponse = z.infer<typeof adminPaymentSummarySchema>;

export const adminPaymentListQuerySchema = z.object({
  status: z.nativeEnum(PaymentAttemptStatus).optional(),
  // true: REVIEW or UNAPPLIED. false: every other status.
  attention: z.enum(["true", "false"]).optional(),
  feeId: z.string().uuid().optional(),
  tutorId: z.string().uuid().optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type AdminPaymentListQuery = z.infer<typeof adminPaymentListQuerySchema>;

// tran_id: our reference, letters and digits, at most 30 characters.
export const tranIdParamSchema = z.object({
  tranId: z.string().regex(/^[A-Za-z0-9]{1,30}$/),
});
export type TranIdParam = z.infer<typeof tranIdParamSchema>;

export const reviewPaymentSchema = z
  .object({
    decision: z.enum(["APPROVE", "REJECT"]),
    note: z.string().trim().min(3).max(500),
  })
  .strict()
  .meta({ id: "ReviewPayment" });
export type ReviewPaymentInput = z.infer<typeof reviewPaymentSchema>;
