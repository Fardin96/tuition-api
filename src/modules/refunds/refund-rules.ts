import { Prisma } from "../../generated/prisma/client.js";
import { RefundStatus } from "../../generated/prisma/enums.js";

type Db = Prisma.TransactionClient;

export const REFUND_WINDOW_DEFAULT_DAYS = 7;

// A refund in one of these states blocks another refund on the same attempt
// (payment_refund_one_open_per_attempt).
export const OPEN_REFUND_STATUSES: RefundStatus[] = [
  RefundStatus.REQUESTED,
  RefundStatus.PROCESSING,
  RefundStatus.NEEDS_REVIEW,
];

// Money promised or already returned. REJECTED and FAILED refunds give their amount back.
const COUNTED_REFUND_STATUSES: RefundStatus[] = [...OPEN_REFUND_STATUSES, RefundStatus.SUCCEEDED];

/** refund_window_days from platform_setting, or the default when the row is missing or malformed. */
export async function readRefundWindowDays(db: Db): Promise<number> {
  const row = await db.platformSetting.findUnique({
    where: { key: "refund_window_days" },
    select: { value: true },
  });
  const value = row?.value;
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : REFUND_WINDOW_DEFAULT_DAYS;
}

/** The last moment a tutor may ask for a refund of a payment settled at `settledAt`. */
export function refundDeadline(settledAt: Date, windowDays: number): Date {
  return new Date(settledAt.getTime() + windowDays * 24 * 60 * 60 * 1000);
}

/**
 * What is still refundable on an attempt: its fee part minus every refund that is open or
 * succeeded. The processing charge is never refunded. Call it under the attempt lock when the
 * answer decides a write.
 */
export async function refundableAmount(
  db: Db,
  attempt: { id: string; feeAmount: Prisma.Decimal },
): Promise<Prisma.Decimal> {
  const counted = await db.paymentRefund.aggregate({
    where: { attemptId: attempt.id, status: { in: COUNTED_REFUND_STATUSES } },
    _sum: { amount: true },
  });
  const left = attempt.feeAmount.minus(counted._sum.amount ?? new Prisma.Decimal(0));
  return left.isNegative() ? new Prisma.Decimal(0) : left;
}

export async function lockRefund(tx: Db, refundId: string) {
  await tx.$queryRaw`SELECT id FROM payment_refund WHERE id = ${refundId}::uuid FOR UPDATE`;
}
