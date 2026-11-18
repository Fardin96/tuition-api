import { Prisma } from "../../generated/prisma/client.js";
import {
  FeeStatus,
  PaymentAttemptStatus,
  RefundSource,
  RefundStatus,
} from "../../generated/prisma/enums.js";
import { writeAudit } from "../../lib/admin.js";
import { decodeCursor, encodeCursor } from "../../lib/cursor.js";
import { appError, notFound } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import {
  GatewayError,
  getPaymentGateway,
  type RefundInitResult,
  type RefundQueryResult,
} from "../../lib/sslcommerz.js";
import { lockAttempt, lockFee } from "../payment/payment.service.js";
import {
  type AdminRefundDetailResponse,
  type AdminRefundResponse,
  adminRefundDetailSelect,
  adminRefundSelect,
  toAdminRefund,
  toAdminRefundDetail,
} from "./refund.schema.js";
import { lockRefund, OPEN_REFUND_STATUSES, refundableAmount } from "./refund-rules.js";

type Tx = Prisma.TransactionClient;
type Actor = { accountId: string };

// Input shapes come from the route schemas (src/modules/admin/refunds.schema.ts), already validated.
export type CreateRefundInput = { tranId: string; amount?: string; reason: string };
export type ResolveRefundInput = {
  outcome: "SUCCEEDED" | "FAILED";
  refundRefId?: string;
  note: string;
};
export type ListRefundsQuery = {
  status?: RefundStatus;
  open?: "true" | "false";
  feeId?: string;
  cursor?: string;
  limit: number;
};

export const NO_BANK_ID_MESSAGE =
  "This payment has no bank transaction id. Refund it from the SSLCommerz merchant panel.";
export const NO_ANSWER_MESSAGE =
  "No answer from the gateway. Check the merchant panel before doing anything else.";
const REFUSED_MESSAGE = "The gateway refused the refund";
const CANCELLED_MESSAGE = "The gateway cancelled the refund";
const OPEN_OR_ALREADY_MESSAGE = "A refund for this payment is already open.";

// Refunds the gateway has been asked about and that are not finished yet.
const IN_FLIGHT: RefundStatus[] = [RefundStatus.PROCESSING, RefundStatus.NEEDS_REVIEW];

type RefundIds = { id: string; feeId: string; attemptId: string };

function refundNotAllowed(message: string) {
  return appError("RefundNotAllowed", 409, message);
}

function invalidRefundState(message: string) {
  return appError("InvalidRefundState", 409, message);
}

function gatewayUnavailable() {
  return appError(
    "GatewayUnavailable",
    503,
    "The payment gateway isn't responding. Try again in a few minutes.",
  );
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

function appendNote(existing: string | null, text: string): string {
  return existing ? `${existing} ${text}` : text;
}

// Lock order is always fee, then attempt, then refund. Every write below takes all three first.
async function lockChain(tx: Tx, ids: RefundIds) {
  await lockFee(tx, ids.feeId);
  await lockAttempt(tx, ids.attemptId);
  await lockRefund(tx, ids.id);
}

async function locateRefund(refundId: string): Promise<RefundIds> {
  const row = await prisma.paymentRefund.findUnique({
    where: { id: refundId },
    select: { id: true, feeId: true, attemptId: true },
  });
  if (!row) throw notFound("Refund not found");
  return row;
}

export async function getRefund(refundId: string): Promise<AdminRefundDetailResponse> {
  const row = await prisma.paymentRefund.findUnique({
    where: { id: refundId },
    select: adminRefundDetailSelect,
  });
  if (!row) throw notFound("Refund not found");
  return toAdminRefundDetail(row);
}

// Steps 2-3 of Execute. The gateway call runs outside any transaction; its answer is recorded in a
// second transaction. Step 1 (REQUESTED -> PROCESSING) lives in the approve and create transactions.
async function executeRefund(refundId: string): Promise<void> {
  // Throws 503 before the call when payments are not configured, so nothing is left in PROCESSING.
  const gateway = getPaymentGateway();
  const row = await prisma.paymentRefund.findUniqueOrThrow({
    where: { id: refundId },
    select: {
      id: true,
      feeId: true,
      attemptId: true,
      amount: true,
      reason: true,
      attempt: { select: { bankTranId: true } },
    },
  });
  const ids: RefundIds = { id: row.id, feeId: row.feeId, attemptId: row.attemptId };
  const bankTranId = row.attempt.bankTranId;
  if (!bankTranId) {
    await recordOutcome(ids, {
      kind: "failed",
      reason: NO_BANK_ID_MESSAGE,
      raw: undefined,
    });
    return;
  }

  let answer: RefundInitResult;
  try {
    answer = await gateway.initiateRefund({
      bankTranId,
      amount: row.amount.toFixed(2),
      remarks: row.reason,
      refeId: row.id,
    });
  } catch (err) {
    // "rejected": the gateway refused, so no money is moving. Anything else: the outcome is unknown.
    if (err instanceof GatewayError && err.kind === "rejected") {
      await recordOutcome(ids, { kind: "failed", reason: err.message, raw: undefined });
    } else {
      await recordOutcome(ids, { kind: "unclear", reason: NO_ANSWER_MESSAGE, raw: undefined });
    }
    return;
  }

  const raw = answer.raw as Prisma.InputJsonObject;
  if ((answer.status === "success" || answer.status === "processing") && answer.refundRefId) {
    try {
      await recordOutcome(ids, {
        kind: "accepted",
        refundRefId: answer.refundRefId,
        raw,
      });
    } catch (err) {
      // The gateway reused a reference that another refund already holds. Do not guess: a person looks.
      if (!isUniqueViolation(err)) throw err;
      await recordOutcome(ids, {
        kind: "unclear",
        reason: `The gateway's answer was unclear: reference ${answer.refundRefId} is already used`,
        raw,
      });
    }
    return;
  }
  if (answer.status === "failed") {
    await recordOutcome(ids, {
      kind: "failed",
      reason: answer.errorReason || REFUSED_MESSAGE,
      raw,
    });
    return;
  }
  await recordOutcome(ids, {
    kind: "unclear",
    reason: `The gateway's answer was unclear: ${answer.status || "empty"}`,
    raw,
  });
}

type Outcome =
  | { kind: "accepted"; refundRefId: string; raw: Prisma.InputJsonObject }
  | { kind: "failed"; reason: string; raw: Prisma.InputJsonObject | undefined }
  | { kind: "unclear"; reason: string; raw: Prisma.InputJsonObject | undefined };

async function recordOutcome(ids: RefundIds, outcome: Outcome): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await lockChain(tx, ids);
    const current = await tx.paymentRefund.findUniqueOrThrow({
      where: { id: ids.id },
      select: { status: true },
    });
    // Only a refund still in PROCESSING takes an answer. Anything else was moved on meanwhile.
    if (current.status !== RefundStatus.PROCESSING) return;

    if (outcome.kind === "accepted") {
      await tx.paymentRefund.update({
        where: { id: ids.id },
        data: {
          refundRefId: outcome.refundRefId,
          gatewayResponse: outcome.raw,
        },
      });
      return;
    }
    if (outcome.kind === "failed") {
      await tx.paymentRefund.update({
        where: { id: ids.id },
        data: {
          status: RefundStatus.FAILED,
          failureReason: outcome.reason,
          completedAt: new Date(),
          gatewayResponse: outcome.raw,
        },
      });
      return;
    }
    await tx.paymentRefund.update({
      where: { id: ids.id },
      data: {
        status: RefundStatus.NEEDS_REVIEW,
        failureReason: outcome.reason,
        gatewayResponse: outcome.raw,
      },
    });
  });
}

/**
 * Complete SUCCEEDED. Runs inside the caller's transaction, after the caller has taken no locks yet:
 * it takes fee, attempt and refund in order. The REVERSAL row is written only when the payment is
 * on the ledger and the fee still accepts ledger rows. The caller writes the audit row.
 */
async function completeRefund(
  tx: Tx,
  ids: RefundIds,
  opts: { actorAccountId: string | null; refundRefId?: string; note?: string },
): Promise<{ reversalId: string | null }> {
  await lockChain(tx, ids);
  const row = await tx.paymentRefund.findUniqueOrThrow({
    where: { id: ids.id },
    select: { status: true, amount: true, paymentId: true, refundRefId: true, decisionNote: true },
  });
  if (!IN_FLIGHT.includes(row.status)) {
    throw invalidRefundState("Only refunds in progress can be completed.");
  }

  const refundRef = opts.refundRefId ?? row.refundRefId;
  let decisionNote = row.decisionNote;
  let reversalId: string | null = null;

  if (row.paymentId) {
    const fee = await tx.platformFee.findUniqueOrThrow({
      where: { id: ids.feeId },
      select: { status: true },
    });
    if (fee.status === FeeStatus.WAIVED || fee.status === FeeStatus.VOID) {
      // The ledger refuses rows on a waived or void fee, and the tutor owes nothing more there.
      decisionNote = appendNote(decisionNote, `Fee was ${fee.status}, ledger unchanged.`);
    } else {
      const reversal = await tx.feePayment.create({
        data: {
          feeId: ids.feeId,
          kind: "REVERSAL",
          reversesPaymentId: row.paymentId,
          amount: row.amount,
          method: "SSLCOMMERZ",
          reason: `Refund ${refundRef ?? ids.id}`,
          receivedAt: new Date(),
          recordedById: opts.actorAccountId,
        },
      });
      reversalId = reversal.id;
    }
  }
  if (opts.note) decisionNote = appendNote(decisionNote, opts.note);

  await tx.paymentRefund.update({
    where: { id: ids.id },
    data: {
      status: RefundStatus.SUCCEEDED,
      completedAt: new Date(),
      reversalId,
      refundRefId: refundRef,
      decisionNote,
      failureReason: null,
    },
  });
  return { reversalId };
}

export async function createAdminRefund(
  input: CreateRefundInput,
  admin: Actor,
  ip: string | undefined,
): Promise<AdminRefundDetailResponse> {
  // Fails with 503 before anything is written when payments are not configured.
  getPaymentGateway();
  const target = await prisma.paymentAttempt.findUnique({
    where: { tranId: input.tranId },
    select: { id: true, feeId: true },
  });
  if (!target) throw notFound("Payment not found");

  // Step 1: under the fee and attempt locks, insert the refund already PROCESSING.
  const refundId = await prisma
    .$transaction(async (tx) => {
      await lockFee(tx, target.feeId);
      await lockAttempt(tx, target.id);
      const attempt = await tx.paymentAttempt.findUniqueOrThrow({
        where: { id: target.id },
        select: {
          status: true,
          tranId: true,
          feeAmount: true,
          bankTranId: true,
          tutorId: true,
          paymentId: true,
        },
      });
      if (
        attempt.status !== PaymentAttemptStatus.SUCCEEDED &&
        attempt.status !== PaymentAttemptStatus.UNAPPLIED
      ) {
        throw refundNotAllowed("Only a payment the gateway took can be refunded.");
      }
      if (!attempt.bankTranId) throw refundNotAllowed(NO_BANK_ID_MESSAGE);

      const open = await tx.paymentRefund.findFirst({
        where: { attemptId: target.id, status: { in: OPEN_REFUND_STATUSES } },
        select: { id: true },
      });
      if (open) throw refundNotAllowed(OPEN_OR_ALREADY_MESSAGE);

      const left = await refundableAmount(tx, { id: target.id, feeAmount: attempt.feeAmount });
      if (left.lessThanOrEqualTo(0)) {
        throw refundNotAllowed("This payment has already been refunded.");
      }
      const amount = input.amount ? new Prisma.Decimal(input.amount) : left;
      if (amount.greaterThan(left)) {
        throw refundNotAllowed(`Only ৳${left.toFixed(2)} is left to refund on this payment.`);
      }

      const refund = await tx.paymentRefund.create({
        data: {
          attemptId: target.id,
          feeId: target.feeId,
          tutorId: attempt.tutorId,
          paymentId: attempt.paymentId,
          amount: amount.toFixed(2),
          reason: input.reason,
          source: RefundSource.ADMIN,
          status: RefundStatus.PROCESSING,
          requestedById: admin.accountId,
          decidedById: admin.accountId,
          decidedAt: new Date(),
        },
      });
      await writeAudit(tx, {
        actorAccountId: admin.accountId,
        action: "refund.create",
        entityType: "payment_refund",
        entityId: refund.id,
        after: {
          status: RefundStatus.PROCESSING,
          amount: amount.toFixed(2),
          tranId: attempt.tranId,
        },
        ip: ip ?? null,
      });
      return refund.id;
    })
    .catch((err: unknown) => {
      if (isUniqueViolation(err)) throw refundNotAllowed(OPEN_OR_ALREADY_MESSAGE);
      throw err;
    });

  // Steps 2-3, outside the transaction.
  await executeRefund(refundId);
  return getRefund(refundId);
}

export async function approveRefund(
  refundId: string,
  note: string | undefined,
  admin: Actor,
  ip: string | undefined,
): Promise<AdminRefundDetailResponse> {
  getPaymentGateway();
  const ids = await locateRefund(refundId);
  await prisma.$transaction(async (tx) => {
    await lockChain(tx, ids);
    const row = await tx.paymentRefund.findUniqueOrThrow({
      where: { id: ids.id },
      select: { status: true, attempt: { select: { bankTranId: true } } },
    });
    if (row.status !== RefundStatus.REQUESTED) {
      throw invalidRefundState("Only refunds waiting for approval can be approved.");
    }
    if (!row.attempt.bankTranId) throw refundNotAllowed(NO_BANK_ID_MESSAGE);

    await tx.paymentRefund.update({
      where: { id: ids.id },
      data: {
        status: RefundStatus.PROCESSING,
        decidedById: admin.accountId,
        decidedAt: new Date(),
        decisionNote: note ?? null,
      },
    });
    await writeAudit(tx, {
      actorAccountId: admin.accountId,
      action: "refund.approve",
      entityType: "payment_refund",
      entityId: ids.id,
      before: { status: RefundStatus.REQUESTED },
      after: { status: RefundStatus.PROCESSING, note: note ?? null },
      ip: ip ?? null,
    });
  });

  await executeRefund(refundId);
  return getRefund(refundId);
}

export async function rejectRefund(
  refundId: string,
  note: string,
  admin: Actor,
  ip: string | undefined,
): Promise<AdminRefundDetailResponse> {
  const ids = await locateRefund(refundId);
  await prisma.$transaction(async (tx) => {
    await lockChain(tx, ids);
    const row = await tx.paymentRefund.findUniqueOrThrow({
      where: { id: ids.id },
      select: { status: true },
    });
    if (row.status !== RefundStatus.REQUESTED) {
      throw invalidRefundState("Only refunds waiting for approval can be declined.");
    }
    const now = new Date();
    await tx.paymentRefund.update({
      where: { id: ids.id },
      data: {
        status: RefundStatus.REJECTED,
        decidedById: admin.accountId,
        decidedAt: now,
        decisionNote: note,
        completedAt: now,
      },
    });
    await writeAudit(tx, {
      actorAccountId: admin.accountId,
      action: "refund.reject",
      entityType: "payment_refund",
      entityId: ids.id,
      before: { status: RefundStatus.REQUESTED },
      after: { status: RefundStatus.REJECTED, note },
      ip: ip ?? null,
    });
  });
  return getRefund(refundId);
}

/**
 * Asks the gateway where a PROCESSING refund stands. Used by the admin route (actor set, audited)
 * and by the cron (actor null). Gateway trouble is 503 GATEWAY_UNAVAILABLE; last_checked_at is set
 * either way.
 */
export async function checkRefund(refundId: string, actor: Actor | null): Promise<void> {
  const ids = await locateRefund(refundId);
  const before = await prisma.paymentRefund.findUniqueOrThrow({
    where: { id: refundId },
    select: { status: true, refundRefId: true },
  });
  if (before.status !== RefundStatus.PROCESSING || !before.refundRefId) {
    throw invalidRefundState("Only refunds in progress can be checked.");
  }

  const gateway = getPaymentGateway();
  let answer: RefundQueryResult;
  try {
    answer = await gateway.queryRefund(before.refundRefId);
  } catch (err) {
    await prisma.paymentRefund.updateMany({
      where: { id: refundId, status: RefundStatus.PROCESSING },
      data: { lastCheckedAt: new Date() },
    });
    if (err instanceof GatewayError) throw gatewayUnavailable();
    throw err;
  }

  await prisma.$transaction(async (tx) => {
    await lockChain(tx, ids);
    const current = await tx.paymentRefund.findUniqueOrThrow({
      where: { id: refundId },
      select: { status: true },
    });
    // Moved on while the gateway was being asked: nothing to write.
    if (current.status !== RefundStatus.PROCESSING) return;

    const now = new Date();
    let after: Prisma.InputJsonObject;
    if (answer.status === "refunded") {
      await completeRefund(tx, ids, { actorAccountId: actor?.accountId ?? null });
      after = { status: RefundStatus.SUCCEEDED, gatewayStatus: answer.status };
    } else if (answer.status === "cancelled") {
      await tx.paymentRefund.update({
        where: { id: refundId },
        data: {
          status: RefundStatus.FAILED,
          failureReason: answer.errorReason || CANCELLED_MESSAGE,
          completedAt: now,
          lastCheckedAt: now,
        },
      });
      after = { status: RefundStatus.FAILED, gatewayStatus: answer.status };
    } else {
      // "processing" or anything else: still with the gateway, nothing to change.
      await tx.paymentRefund.update({
        where: { id: refundId },
        data: { lastCheckedAt: now },
      });
      after = { status: RefundStatus.PROCESSING, gatewayStatus: answer.status };
    }

    if (actor) {
      await writeAudit(tx, {
        actorAccountId: actor.accountId,
        action: "refund.check",
        entityType: "payment_refund",
        entityId: refundId,
        before: { status: RefundStatus.PROCESSING },
        after,
      });
    }
  });
}

/**
 * Cron only: a PROCESSING refund with no gateway reference that nobody has touched since `cutoff`
 * means the process died between the two transactions. Its outcome is unknown, so it needs review.
 * Returns true when it changed the row.
 */
export async function markNoAnswer(refundId: string, cutoff: Date): Promise<boolean> {
  const ids = await locateRefund(refundId);
  return prisma.$transaction(async (tx) => {
    await lockChain(tx, ids);
    const row = await tx.paymentRefund.findUniqueOrThrow({
      where: { id: refundId },
      select: { status: true, refundRefId: true, updatedAt: true },
    });
    if (
      row.status !== RefundStatus.PROCESSING ||
      row.refundRefId !== null ||
      row.updatedAt.getTime() >= cutoff.getTime()
    ) {
      return false;
    }
    await tx.paymentRefund.update({
      where: { id: refundId },
      data: { status: RefundStatus.NEEDS_REVIEW, failureReason: NO_ANSWER_MESSAGE },
    });
    return true;
  });
}

export async function resolveRefund(
  refundId: string,
  input: ResolveRefundInput,
  admin: Actor,
  ip: string | undefined,
): Promise<AdminRefundDetailResponse> {
  const ids = await locateRefund(refundId);
  await prisma
    .$transaction(async (tx) => {
      await lockChain(tx, ids);
      const before = await tx.paymentRefund.findUniqueOrThrow({
        where: { id: ids.id },
        select: { status: true, failureReason: true },
      });
      if (before.status !== RefundStatus.NEEDS_REVIEW) {
        throw invalidRefundState("Only refunds that need review can be resolved.");
      }

      let after: Prisma.InputJsonObject;
      if (input.outcome === "SUCCEEDED") {
        await completeRefund(tx, ids, {
          actorAccountId: admin.accountId,
          refundRefId: input.refundRefId,
          note: input.note,
        });
        after = {
          status: RefundStatus.SUCCEEDED,
          outcome: input.outcome,
          refundRefId: input.refundRefId ?? null,
          note: input.note,
        };
      } else {
        await tx.paymentRefund.update({
          where: { id: ids.id },
          data: {
            status: RefundStatus.FAILED,
            failureReason: input.note,
            completedAt: new Date(),
          },
        });
        after = { status: RefundStatus.FAILED, outcome: input.outcome, note: input.note };
      }

      await writeAudit(tx, {
        actorAccountId: admin.accountId,
        action: "refund.resolve",
        entityType: "payment_refund",
        entityId: ids.id,
        before: { status: RefundStatus.NEEDS_REVIEW, failureReason: before.failureReason },
        after,
        ip: ip ?? null,
      });
    })
    .catch((err: unknown) => {
      if (isUniqueViolation(err)) {
        throw invalidRefundState("That gateway reference is already on another refund.");
      }
      throw err;
    });
  return getRefund(refundId);
}

export async function listRefunds(
  query: ListRefundsQuery,
): Promise<{ refunds: AdminRefundResponse[]; nextCursor: string | null }> {
  const clauses: Prisma.PaymentRefundWhereInput[] = [];
  if (query.status) clauses.push({ status: query.status });
  if (query.open === "true") clauses.push({ status: { in: OPEN_REFUND_STATUSES } });
  if (query.open === "false") clauses.push({ status: { notIn: OPEN_REFUND_STATUSES } });
  if (query.feeId) clauses.push({ feeId: query.feeId });
  if (query.cursor) {
    const cursor = decodeCursor(query.cursor);
    clauses.push({
      OR: [
        { createdAt: { lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, id: { lt: cursor.id } },
      ],
    });
  }

  const rows = await prisma.paymentRefund.findMany({
    where: { AND: clauses },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: query.limit + 1,
    select: adminRefundSelect,
  });
  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];

  return {
    refunds: page.map(toAdminRefund),
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
  };
}
