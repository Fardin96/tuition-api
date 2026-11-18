import { z } from "zod";
import type { Prisma } from "../../generated/prisma/client.js";
import {
  FeeStatus,
  PaymentAttemptStatus,
  RefundSource,
  RefundStatus,
} from "../../generated/prisma/enums.js";

// Money is always a 2-decimal string, for example "1537.50".

// The tutor's view of a refund on their fee: no gateway details, no admin names.
export const tutorRefundSchema = z
  .object({
    id: z.string(),
    paymentId: z.string().nullable(),
    amount: z.string(),
    status: z.nativeEnum(RefundStatus),
    reason: z.string(),
    createdAt: z.date(),
    completedAt: z.date().nullable(),
    decisionNote: z.string().nullable(),
  })
  .meta({ id: "TutorRefund" });
export type TutorRefundResponse = z.infer<typeof tutorRefundSchema>;

export const adminRefundSchema = z
  .object({
    id: z.string(),
    status: z.nativeEnum(RefundStatus),
    source: z.nativeEnum(RefundSource),
    amount: z.string(),
    reason: z.string(),
    refundRefId: z.string().nullable(),
    failureReason: z.string().nullable(),
    decisionNote: z.string().nullable(),
    createdAt: z.date(),
    updatedAt: z.date(),
    decidedAt: z.date().nullable(),
    completedAt: z.date().nullable(),
    lastCheckedAt: z.date().nullable(),
    attempt: z.object({
      tranId: z.string(),
      status: z.nativeEnum(PaymentAttemptStatus),
      feeAmount: z.string(),
      totalAmount: z.string(),
      bankTranId: z.string().nullable(),
    }),
    fee: z.object({
      id: z.string(),
      status: z.nativeEnum(FeeStatus),
      amountDue: z.string(),
      amountPaid: z.string(),
    }),
    tutor: z.object({ id: z.string(), name: z.string() }),
    requestedByName: z.string(),
    decidedByName: z.string().nullable(),
    reversalId: z.string().nullable(),
  })
  .meta({ id: "AdminRefund" });
export type AdminRefundResponse = z.infer<typeof adminRefundSchema>;

export const adminRefundDetailSchema = adminRefundSchema
  .extend({
    gatewayResponse: z.record(z.string(), z.unknown()).nullable(),
    canApprove: z.boolean(),
    canReject: z.boolean(),
    canCheck: z.boolean(),
    canResolve: z.boolean(),
  })
  .meta({ id: "AdminRefundDetail" });
export type AdminRefundDetailResponse = z.infer<typeof adminRefundDetailSchema>;

// Selects and mappers shared by the admin refund routes, the admin fee detail and the attempt detail.
export const adminRefundSelect = {
  id: true,
  status: true,
  source: true,
  amount: true,
  reason: true,
  refundRefId: true,
  failureReason: true,
  decisionNote: true,
  createdAt: true,
  updatedAt: true,
  decidedAt: true,
  completedAt: true,
  lastCheckedAt: true,
  reversalId: true,
  attempt: {
    select: { tranId: true, status: true, feeAmount: true, totalAmount: true, bankTranId: true },
  },
  fee: { select: { id: true, status: true, amountDue: true, amountPaid: true } },
  tutor: { select: { id: true, name: true } },
  requestedBy: {
    select: {
      email: true,
      tutor: { select: { name: true } },
      adminUser: { select: { name: true } },
    },
  },
  decidedBy: { select: { name: true } },
} satisfies Prisma.PaymentRefundSelect;

export const adminRefundDetailSelect = {
  ...adminRefundSelect,
  gatewayResponse: true,
} satisfies Prisma.PaymentRefundSelect;

type AdminRefundRow = Prisma.PaymentRefundGetPayload<{ select: typeof adminRefundSelect }>;
type AdminRefundDetailRow = Prisma.PaymentRefundGetPayload<{
  select: typeof adminRefundDetailSelect;
}>;

export function toAdminRefund(row: AdminRefundRow): AdminRefundResponse {
  const requester = row.requestedBy;
  return {
    id: row.id,
    status: row.status,
    source: row.source,
    amount: row.amount.toFixed(2),
    reason: row.reason,
    refundRefId: row.refundRefId,
    failureReason: row.failureReason,
    decisionNote: row.decisionNote,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    decidedAt: row.decidedAt,
    completedAt: row.completedAt,
    lastCheckedAt: row.lastCheckedAt,
    attempt: {
      tranId: row.attempt.tranId,
      status: row.attempt.status,
      feeAmount: row.attempt.feeAmount.toFixed(2),
      totalAmount: row.attempt.totalAmount.toFixed(2),
      bankTranId: row.attempt.bankTranId,
    },
    fee: {
      id: row.fee.id,
      status: row.fee.status,
      amountDue: row.fee.amountDue.toFixed(2),
      amountPaid: row.fee.amountPaid.toFixed(2),
    },
    tutor: { id: row.tutor.id, name: row.tutor.name },
    requestedByName: requester.adminUser?.name || requester.tutor?.name || requester.email,
    decidedByName: row.decidedBy?.name ?? null,
    reversalId: row.reversalId,
  };
}

function plainObjectOrNull(value: Prisma.JsonValue | null): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function toAdminRefundDetail(row: AdminRefundDetailRow): AdminRefundDetailResponse {
  return {
    ...toAdminRefund(row),
    gatewayResponse: plainObjectOrNull(row.gatewayResponse),
    canApprove: row.status === "REQUESTED",
    canReject: row.status === "REQUESTED",
    canCheck: row.status === "PROCESSING" && row.refundRefId !== null,
    canResolve: row.status === "NEEDS_REVIEW",
  };
}

export const tutorRefundSelect = {
  id: true,
  paymentId: true,
  amount: true,
  status: true,
  reason: true,
  createdAt: true,
  completedAt: true,
  decisionNote: true,
} satisfies Prisma.PaymentRefundSelect;

export function toTutorRefund(
  row: Prisma.PaymentRefundGetPayload<{ select: typeof tutorRefundSelect }>,
): TutorRefundResponse {
  return { ...row, amount: row.amount.toFixed(2) };
}
