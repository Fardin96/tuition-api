import type { Prisma } from "../../generated/prisma/client.js";
import { PaymentAttemptStatus } from "../../generated/prisma/enums.js";
import { writeAudit } from "../../lib/admin.js";
import { decodeCursor, encodeCursor } from "../../lib/cursor.js";
import { appError, notFound } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { GatewayError, paymentsConfigured } from "../../lib/sslcommerz.js";
import {
  ledgerBlock,
  lockAttempt,
  lockFee,
  reconcileAttempt,
  SETTLABLE,
} from "../payment/payment.service.js";
import { adminRefundSelect, toAdminRefund } from "../refunds/refund.schema.js";
import { refundableAmount } from "../refunds/refund-rules.js";
import type {
  AdminPaymentAttemptDetailResponse,
  AdminPaymentAttemptResponse,
  AdminPaymentListQuery,
  AdminPaymentSummaryResponse,
  ReviewPaymentInput,
} from "./payments.schema.js";

type Tx = Prisma.TransactionClient;

const DAY_MS = 24 * 60 * 60 * 1000;
// A PENDING attempt older than this is "stale": the gateway has not settled it and nobody is waiting.
const STALE_PENDING_MS = 60 * 60 * 1000;
// Statuses an admin must look at: the gateway took money and no ledger row was written.
const ATTENTION_STATUSES: PaymentAttemptStatus[] = [
  PaymentAttemptStatus.REVIEW,
  PaymentAttemptStatus.UNAPPLIED,
];

const attemptSelect = {
  id: true,
  tranId: true,
  status: true,
  feeAmount: true,
  chargeAmount: true,
  totalAmount: true,
  failureReason: true,
  valId: true,
  bankTranId: true,
  cardType: true,
  riskLevel: true,
  paymentId: true,
  createdAt: true,
  updatedAt: true,
  lastCheckedAt: true,
  settledAt: true,
  fee: { select: { id: true, status: true, amountDue: true, amountPaid: true } },
  tutor: { select: { id: true, name: true } },
} satisfies Prisma.PaymentAttemptSelect;

const detailSelect = {
  ...attemptSelect,
  gatewayResponse: true,
  refunds: {
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: adminRefundSelect,
  },
} satisfies Prisma.PaymentAttemptSelect;

type AttemptRow = Prisma.PaymentAttemptGetPayload<{ select: typeof attemptSelect }>;
type DetailRow = Prisma.PaymentAttemptGetPayload<{ select: typeof detailSelect }>;

function toAttempt(row: AttemptRow): AdminPaymentAttemptResponse {
  return {
    id: row.id,
    tranId: row.tranId,
    status: row.status,
    feeAmount: row.feeAmount.toFixed(2),
    chargeAmount: row.chargeAmount.toFixed(2),
    totalAmount: row.totalAmount.toFixed(2),
    failureReason: row.failureReason,
    valId: row.valId,
    bankTranId: row.bankTranId,
    cardType: row.cardType,
    riskLevel: row.riskLevel,
    paymentId: row.paymentId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastCheckedAt: row.lastCheckedAt,
    settledAt: row.settledAt,
    fee: {
      id: row.fee.id,
      status: row.fee.status,
      amountDue: row.fee.amountDue.toFixed(2),
      amountPaid: row.fee.amountPaid.toFixed(2),
    },
    tutor: { id: row.tutor.id, name: row.tutor.name },
  };
}

// gatewayResponse is free-form JSON. Anything that is not a plain object is shown as null.
function plainObjectOrNull(value: Prisma.JsonValue | null): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

async function toDetail(db: Tx, row: DetailRow): Promise<AdminPaymentAttemptDetailResponse> {
  // Only a gateway payment with a bank transaction id can be refunded through the gateway.
  const refundable =
    (row.status === PaymentAttemptStatus.SUCCEEDED ||
      row.status === PaymentAttemptStatus.UNAPPLIED) &&
    row.bankTranId !== null
      ? (await refundableAmount(db, row)).toFixed(2)
      : "0.00";
  return {
    ...toAttempt(row),
    gatewayResponse: plainObjectOrNull(row.gatewayResponse),
    canCheck: SETTLABLE.includes(row.status) && paymentsConfigured(),
    canReview: row.status === PaymentAttemptStatus.REVIEW,
    refundable,
    refunds: row.refunds.map((refund) => toAdminRefund(refund)),
  };
}

// Re-reads the attempt after a write, so the response shows what was stored.
async function readDetail(db: Tx, tranId: string): Promise<AdminPaymentAttemptDetailResponse> {
  const row = await db.paymentAttempt.findUnique({ where: { tranId }, select: detailSelect });
  if (!row) throw notFound("Payment not found");
  return toDetail(db, row);
}

// Keyset over (createdAt desc, id desc), the same shape as listFees.
export async function listPaymentAttempts(query: AdminPaymentListQuery): Promise<{
  attempts: AdminPaymentAttemptResponse[];
  nextCursor: string | null;
}> {
  const clauses: Prisma.PaymentAttemptWhereInput[] = [];

  if (query.status) clauses.push({ status: query.status });
  if (query.attention === "true") {
    clauses.push({ status: { in: ATTENTION_STATUSES } });
  } else if (query.attention === "false") {
    clauses.push({ status: { notIn: ATTENTION_STATUSES } });
  }
  if (query.feeId) clauses.push({ feeId: query.feeId });
  if (query.tutorId) clauses.push({ tutorId: query.tutorId });
  if (query.cursor) {
    const cursor = decodeCursor(query.cursor);
    clauses.push({
      OR: [
        { createdAt: { lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, id: { lt: cursor.id } },
      ],
    });
  }

  const rows = await prisma.paymentAttempt.findMany({
    where: { AND: clauses },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: query.limit + 1,
    select: attemptSelect,
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];

  return {
    attempts: page.map(toAttempt),
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
  };
}

export async function paymentAttemptSummary(
  now: Date = new Date(),
): Promise<AdminPaymentSummaryResponse> {
  const staleBefore = new Date(now.getTime() - STALE_PENDING_MS);
  const dayAgo = new Date(now.getTime() - DAY_MS);

  const [review, unapplied, stalePending, recent] = await Promise.all([
    prisma.paymentAttempt.count({ where: { status: PaymentAttemptStatus.REVIEW } }),
    prisma.paymentAttempt.count({ where: { status: PaymentAttemptStatus.UNAPPLIED } }),
    prisma.paymentAttempt.count({
      where: { status: PaymentAttemptStatus.PENDING, createdAt: { lt: staleBefore } },
    }),
    prisma.paymentAttempt.aggregate({
      where: { status: PaymentAttemptStatus.SUCCEEDED, settledAt: { gte: dayAgo } },
      _count: { _all: true },
      _sum: { feeAmount: true },
    }),
  ]);

  return {
    review,
    unapplied,
    stalePending,
    succeeded24h: recent._count._all,
    collected24h: recent._sum.feeAmount?.toFixed(2) ?? "0.00",
  };
}

export async function getPaymentAttempt(
  tranId: string,
): Promise<AdminPaymentAttemptDetailResponse> {
  const row = await prisma.paymentAttempt.findUnique({ where: { tranId }, select: detailSelect });
  if (!row) throw notFound("Payment not found");
  return toDetail(prisma, row);
}

// Asks the gateway about one attempt, outside any transaction. The audit row is written after.
export async function checkPaymentAttempt(
  tranId: string,
  admin: { accountId: string },
  ip: string | undefined,
): Promise<AdminPaymentAttemptDetailResponse> {
  const before = await prisma.paymentAttempt.findUnique({
    where: { tranId },
    select: { id: true, status: true },
  });
  if (!before) throw notFound("Payment not found");
  if (!SETTLABLE.includes(before.status)) {
    throw appError("InvalidPaymentState", 409, "This payment is already final.");
  }
  if (!paymentsConfigured()) {
    throw appError("PaymentsDisabled", 503, "Payments aren't configured on this server.");
  }

  try {
    await reconcileAttempt(tranId);
  } catch (err) {
    if (err instanceof GatewayError) {
      throw appError(
        "GatewayUnavailable",
        503,
        "The payment gateway isn't responding. Try again in a few minutes.",
      );
    }
    throw err;
  }

  return prisma.$transaction(async (tx) => {
    const after = await tx.paymentAttempt.findUniqueOrThrow({
      where: { id: before.id },
      select: { status: true },
    });
    await writeAudit(tx, {
      actorAccountId: admin.accountId,
      action: "payment.check",
      entityType: "payment_attempt",
      entityId: before.id,
      before: { status: before.status },
      after: { status: after.status },
      ip: ip ?? null,
    });
    return readDetail(tx, tranId);
  });
}

// A REVIEW attempt is decided by a super admin. APPROVE posts the fee part to the ledger when the
// ledger accepts it; REJECT leaves the money with the gateway, for a refund outside this system.
export async function reviewPaymentAttempt(
  tranId: string,
  input: ReviewPaymentInput,
  admin: { accountId: string },
  ip: string | undefined,
): Promise<AdminPaymentAttemptDetailResponse> {
  return prisma.$transaction(async (tx) => {
    const target = await tx.paymentAttempt.findUnique({
      where: { tranId },
      select: { id: true, feeId: true },
    });
    if (!target) throw notFound("Payment not found");

    // Lock order: the fee row, then the attempt row. Same order as settleAttempt.
    await lockFee(tx, target.feeId);
    await lockAttempt(tx, target.id);
    // Re-read under the locks: the status may have moved since the lookup above.
    const attempt = await tx.paymentAttempt.findUniqueOrThrow({
      where: { id: target.id },
      select: { id: true, feeId: true, status: true, feeAmount: true, failureReason: true },
    });
    if (attempt.status !== PaymentAttemptStatus.REVIEW) {
      throw appError(
        "InvalidPaymentState",
        409,
        "Only payments waiting for review can be decided.",
      );
    }

    let status: PaymentAttemptStatus;
    let failureReason: string | null;
    let paymentId: string | null = null;
    let settledAt: Date | null = null;

    if (input.decision === "APPROVE") {
      const fee = await tx.platformFee.findUniqueOrThrow({
        where: { id: attempt.feeId },
        select: { status: true, amountDue: true, amountPaid: true },
      });
      const blocked = await ledgerBlock(tx, fee, attempt.feeAmount, tranId);
      if (blocked) {
        status = PaymentAttemptStatus.UNAPPLIED;
        failureReason = blocked;
      } else {
        const payment = await tx.feePayment.create({
          data: {
            feeId: attempt.feeId,
            kind: "PAYMENT",
            amount: attempt.feeAmount,
            method: "SSLCOMMERZ",
            txnReference: tranId,
            receivedAt: new Date(),
            recordedById: admin.accountId,
          },
        });
        status = PaymentAttemptStatus.SUCCEEDED;
        failureReason = null;
        paymentId = payment.id;
        settledAt = new Date();
      }
    } else {
      status = PaymentAttemptStatus.UNAPPLIED;
      failureReason = `Rejected in review: ${input.note}`;
    }

    const updated = await tx.paymentAttempt.update({
      where: { id: attempt.id },
      data: { status, failureReason, paymentId, settledAt },
      select: { status: true },
    });

    await writeAudit(tx, {
      actorAccountId: admin.accountId,
      action: "payment.review",
      entityType: "payment_attempt",
      entityId: attempt.id,
      before: { status: PaymentAttemptStatus.REVIEW, failureReason: attempt.failureReason },
      after: { status: updated.status, decision: input.decision, note: input.note },
      ip: ip ?? null,
    });
    return readDetail(tx, tranId);
  });
}
