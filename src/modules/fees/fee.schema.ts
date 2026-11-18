import { z } from "zod";
import { FeeStatus, FeeType, PaymentKind, PaymentMethod } from "../../generated/prisma/enums.js";
import { tutorRefundSchema } from "../refunds/refund.schema.js";

export const feeIdParamSchema = z.object({ id: z.string().uuid() });
export type FeeIdParam = z.infer<typeof feeIdParamSchema>;

export const feeListQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
});
export type FeeListQuery = z.infer<typeof feeListQuerySchema>;

export const tutorFeeSchema = z
  .object({
    id: z.string(),
    feeType: z.nativeEnum(FeeType),
    status: z.nativeEnum(FeeStatus),
    amountDue: z.string(),
    amountPaid: z.string(),
    remaining: z.string(),
    /** YYYY-MM-DD */
    dueDate: z.string(),
    /** DUE or PARTIAL and dueDate is before today (Asia/Dhaka). */
    overdue: z.boolean(),
    /** DUE or PARTIAL more than FEE_UNPAID_AFTER_DAYS after the application was confirmed. */
    unpaid: z.boolean(),
    createdAt: z.date(),
    application: z.object({
      id: z.string(),
      kind: z.enum(["REQUIREMENT", "PACKAGE"]),
      confirmedAt: z.date().nullable(),
      packageTitle: z.string().nullable(),
      studentName: z.string(),
    }),
  })
  .meta({ id: "TutorFee" });
export type TutorFeeResponse = z.infer<typeof tutorFeeSchema>;

export const tutorFeePageSchema = z
  .object({
    fees: z.array(tutorFeeSchema),
    nextCursor: z.string().nullable(),
  })
  .meta({ id: "TutorFeePage" });
export type TutorFeePageResponse = z.infer<typeof tutorFeePageSchema>;

// The tutor's own view of a ledger row: no recorder, no txn reference.
export const tutorFeePaymentSchema = z
  .object({
    id: z.string(),
    kind: z.nativeEnum(PaymentKind),
    amount: z.string(),
    method: z.nativeEnum(PaymentMethod),
    receivedAt: z.date(),
    reversesPaymentId: z.string().nullable(),
    /** Set on an online payment that the tutor can still ask to have refunded, until this moment. */
    refundableUntil: z.date().nullable(),
  })
  .meta({ id: "TutorFeePayment" });
export type TutorFeePaymentResponse = z.infer<typeof tutorFeePaymentSchema>;

export const checkoutQuoteSchema = z
  .object({
    enabled: z.boolean(),
    /** PAYMENTS_OFF: payments are off or not configured. BELOW_MINIMUM: total under the gateway minimum. */
    unavailableReason: z.enum(["PAYMENTS_OFF", "BELOW_MINIMUM"]).nullable(),
    feeAmount: z.string(),
    chargePercent: z.string(),
    chargeAmount: z.string(),
    totalAmount: z.string(),
  })
  .meta({ id: "CheckoutQuote" });
export type CheckoutQuoteResponse = z.infer<typeof checkoutQuoteSchema>;

// The promo code applied to a fee (its ACTIVE redemption). Money is a 2-decimal string.
export const feePromoSchema = z
  .object({
    code: z.string(),
    discountAmount: z.string(),
    originalAmount: z.string(),
    appliedAt: z.date(),
  })
  .meta({ id: "FeePromo" });
export type FeePromoResponse = z.infer<typeof feePromoSchema>;

export const applyPromoSchema = z
  .object({
    code: z.string().trim().min(1).max(32),
  })
  .strict()
  .meta({ id: "ApplyPromo" });
export type ApplyPromoInput = z.infer<typeof applyPromoSchema>;

// The tutor asks for a refund of one online payment on the fee. The reason is required.
export const requestRefundSchema = z
  .object({
    paymentId: z.string().uuid(),
    reason: z.string().trim().min(3).max(500),
  })
  .strict()
  .meta({ id: "RequestRefund" });
export type RequestRefundInput = z.infer<typeof requestRefundSchema>;

export const tutorFeeDetailSchema = tutorFeeSchema
  .extend({
    payments: z.array(tutorFeePaymentSchema),
    /** The fee's refund requests, newest first. */
    refunds: z.array(tutorRefundSchema),
    /** null unless the fee is DUE or PARTIAL with something left to pay. */
    checkout: checkoutQuoteSchema.nullable(),
    /** The PENDING gateway attempt for this fee, if one is in progress. */
    pendingAttempt: z
      .object({
        tranId: z.string(),
        createdAt: z.date(),
      })
      .nullable(),
    /** The promo code on this fee, if one is applied. */
    promo: feePromoSchema.nullable(),
    /** A code can be applied: the fee is DUE, nothing is paid and no code is applied yet. */
    promoAllowed: z.boolean(),
  })
  .meta({ id: "TutorFeeDetail" });
export type TutorFeeDetailResponse = z.infer<typeof tutorFeeDetailSchema>;
