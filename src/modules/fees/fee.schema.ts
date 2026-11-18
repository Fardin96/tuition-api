import { z } from "zod";
import { FeeStatus, FeeType, PaymentKind, PaymentMethod } from "../../generated/prisma/enums.js";

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

export const tutorFeeDetailSchema = tutorFeeSchema
  .extend({
    payments: z.array(tutorFeePaymentSchema),
    /** null unless the fee is DUE or PARTIAL with something left to pay. */
    checkout: checkoutQuoteSchema.nullable(),
    /** The PENDING gateway attempt for this fee, if one is in progress. */
    pendingAttempt: z
      .object({
        tranId: z.string(),
        createdAt: z.date(),
      })
      .nullable(),
  })
  .meta({ id: "TutorFeeDetail" });
export type TutorFeeDetailResponse = z.infer<typeof tutorFeeDetailSchema>;
