import { z } from "zod";
import {
  ApplicationStatus,
  FeeStatus,
  FeeType,
  PaymentAttemptStatus,
  PaymentKind,
  PaymentMethod,
} from "../../generated/prisma/enums.js";
import { feePromoSchema } from "../fees/fee.schema.js";

export const FEE_MAX_AMOUNT = 5_000_000;

// BDT: positive, at most 2 decimals, at most FEE_MAX_AMOUNT.
const moneySchema = z
  .number()
  .positive()
  .max(FEE_MAX_AMOUNT)
  .refine((n) => Math.round(n * 100) / 100 === n, {
    message: "Amount can have at most 2 decimal places",
  });

// YYYY-MM-DD that is also a real calendar day (2026-02-30 is rejected).
const dueDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .refine(
    (s) => {
      const d = new Date(`${s}T00:00:00.000Z`);
      return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
    },
    { message: "Use a real calendar date (YYYY-MM-DD)" },
  );

const noteSchema = z.string().trim().min(1).max(500);

export const feeIdParamSchema = z.object({ id: z.string().uuid() });
export type FeeIdParam = z.infer<typeof feeIdParamSchema>;

export const paymentIdParamSchema = z.object({ id: z.string().uuid() });
export type PaymentIdParam = z.infer<typeof paymentIdParamSchema>;

export const createFeeSchema = z
  .object({
    applicationId: z.string().uuid(),
    feeType: z.nativeEnum(FeeType).default("OTHER"),
    amountDue: moneySchema,
    dueDate: dueDateSchema,
    note: noteSchema.optional(),
  })
  .strict()
  .meta({ id: "CreateFee" });
export type CreateFeeInput = z.infer<typeof createFeeSchema>;

// note: null clears it. At least one field must be sent.
export const updateFeeSchema = z
  .object({
    dueDate: dueDateSchema.optional(),
    note: noteSchema.nullable().optional(),
    status: z.enum(["WAIVED", "VOID"]).optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "Send at least one field to change",
  })
  .meta({ id: "UpdateFee" });
export type UpdateFeeInput = z.infer<typeof updateFeeSchema>;

export const recordPaymentSchema = z
  .object({
    amount: moneySchema,
    receivedAt: z
      .string()
      .datetime({ offset: true })
      .refine((v) => new Date(v).getTime() <= Date.now(), {
        message: "receivedAt cannot be in the future",
      })
      .optional(),
    txnReference: z.string().trim().min(1).max(100).optional(),
  })
  .strict()
  .meta({ id: "RecordPayment" });
export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>;

export const reversePaymentSchema = z
  .object({
    reason: z.string().trim().min(3).max(500),
    // Defaults to whatever is still left to reverse on the payment.
    amount: moneySchema.optional(),
  })
  .strict()
  .meta({ id: "ReversePayment" });
export type ReversePaymentInput = z.infer<typeof reversePaymentSchema>;

export const adminFeeListQuerySchema = z.object({
  status: z.nativeEnum(FeeStatus).optional(),
  tutorId: z.string().uuid().optional(),
  // true: DUE or PARTIAL and dueDate before today (Asia/Dhaka). false: the opposite.
  overdue: z.enum(["true", "false"]).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type AdminFeeListQuery = z.infer<typeof adminFeeListQuerySchema>;

export const adminFeePaymentSchema = z
  .object({
    id: z.string(),
    kind: z.nativeEnum(PaymentKind),
    amount: z.string(),
    method: z.nativeEnum(PaymentMethod),
    txnReference: z.string().nullable(),
    reason: z.string().nullable(),
    receivedAt: z.date(),
    createdAt: z.date(),
    // null for gateway (SSLCOMMERZ) payments, which have no admin recorder.
    recordedByName: z.string().nullable(),
    reversesPaymentId: z.string().nullable(),
    /** PAYMENT rows: the sum of REVERSAL rows pointing at it. "0.00" for REVERSAL rows. */
    reversedAmount: z.string(),
  })
  .meta({ id: "AdminFeePayment" });

export const adminFeeSchema = z
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
    note: z.string().nullable(),
    createdAt: z.date(),
    updatedAt: z.date(),
    tutor: z.object({ id: z.string(), name: z.string() }),
    student: z.object({ id: z.string(), name: z.string() }),
    application: z.object({
      id: z.string(),
      status: z.nativeEnum(ApplicationStatus),
      kind: z.enum(["REQUIREMENT", "PACKAGE"]),
      confirmedAt: z.date().nullable(),
      packageTitle: z.string().nullable(),
    }),
  })
  .meta({ id: "AdminFee" });
export type AdminFeeResponse = z.infer<typeof adminFeeSchema>;

// Online (SSLCommerz) checkouts of this fee, newest first. Only the last 20 are sent.
export const adminFeeAttemptSchema = z
  .object({
    tranId: z.string(),
    status: z.nativeEnum(PaymentAttemptStatus),
    totalAmount: z.string(),
    failureReason: z.string().nullable(),
    createdAt: z.date(),
    settledAt: z.date().nullable(),
  })
  .meta({ id: "AdminFeeAttempt" });

export const adminFeeDetailSchema = adminFeeSchema
  .extend({
    payments: z.array(adminFeePaymentSchema),
    attempts: z.array(adminFeeAttemptSchema),
    /** The promo code applied to the fee, or null. The same object the tutor sees. */
    promo: feePromoSchema.nullable(),
  })
  .meta({ id: "AdminFeeDetail" });
export type AdminFeeDetailResponse = z.infer<typeof adminFeeDetailSchema>;

export const adminFeePageSchema = z
  .object({
    fees: z.array(adminFeeSchema),
    nextCursor: z.string().nullable(),
  })
  .meta({ id: "AdminFeePage" });
