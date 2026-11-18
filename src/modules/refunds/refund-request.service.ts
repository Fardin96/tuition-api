import { Prisma } from "../../generated/prisma/client.js";
import {
  PaymentAttemptStatus,
  PaymentKind,
  PaymentMethod,
  RefundSource,
  RefundStatus,
} from "../../generated/prisma/enums.js";
import { appError, notFound } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import type { RequestRefundInput, TutorFeeDetailResponse } from "../fees/fee.schema.js";
import { getMyFee } from "../fees/fee.service.js";
import { lockAttempt, lockFee } from "../payment/payment.service.js";
import {
  OPEN_REFUND_STATUSES,
  readRefundWindowDays,
  refundableAmount,
  refundDeadline,
} from "./refund-rules.js";

const FEE_NOT_FOUND = "Fee not found";
const PAYMENT_NOT_FOUND = "Payment not found";
const NOT_ONLINE = "Only online payments can be refunded here.";
const NO_BANK_ID =
  "This payment has no bank transaction id. Refund it from the SSLCommerz merchant panel.";
const WINDOW_CLOSED = "The refund window for this payment has closed.";
const ALREADY_OPEN = "A refund for this payment is already open.";
const ALREADY_REFUNDED = "This payment has already been refunded.";
const NOT_REFUNDABLE = "This payment can't be refunded.";
// The one-open-refund-per-attempt index. Any unique violation on insert can only come from it.
const ONE_OPEN_INDEX = "payment_refund_one_open_per_attempt";

function refundNotAllowed(message: string) {
  return appError("RefundNotAllowed", 409, message);
}

function isOpenRefundConflict(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return true;
  const text = err instanceof Error ? err.message : "";
  return text.includes(ONE_OPEN_INDEX) || text.includes("unique_violation");
}

// A tutor asks for a refund of one SSLCommerz payment on their own fee. The request is for the whole
// refundable fee part; a super admin approves it (or declines it) later.
export async function requestRefund(
  accountId: string,
  feeId: string,
  input: RequestRefundInput,
): Promise<TutorFeeDetailResponse> {
  // Owner only: another tutor's fee is indistinguishable from a missing one.
  const fee = await prisma.platformFee.findFirst({
    where: { id: feeId, tutor: { accountId } },
    select: { id: true, tutorId: true },
  });
  if (!fee) throw notFound(FEE_NOT_FOUND);

  // The ledger row must be a payment on this fee. Reversals and other fees' payments are not found.
  const payment = await prisma.feePayment.findFirst({
    where: { id: input.paymentId, feeId, kind: PaymentKind.PAYMENT },
    select: { id: true, method: true },
  });
  if (!payment) throw notFound(PAYMENT_NOT_FOUND);
  if (payment.method !== PaymentMethod.SSLCOMMERZ) throw refundNotAllowed(NOT_ONLINE);

  // An online payment with no attempt has no bank transaction id we can refund against.
  const attempt = await prisma.paymentAttempt.findUnique({
    where: { paymentId: payment.id },
    select: { id: true },
  });
  if (!attempt) throw refundNotAllowed(NO_BANK_ID);

  try {
    await prisma.$transaction(async (tx) => {
      // Lock order: fee, then attempt. Every check below reads under those locks.
      await lockFee(tx, feeId);
      await lockAttempt(tx, attempt.id);
      const current = await tx.paymentAttempt.findUniqueOrThrow({
        where: { id: attempt.id },
        select: { feeAmount: true, status: true, bankTranId: true, settledAt: true },
      });
      if (current.status !== PaymentAttemptStatus.SUCCEEDED || current.settledAt === null) {
        throw refundNotAllowed(NOT_REFUNDABLE);
      }

      const windowDays = await readRefundWindowDays(tx);
      const now = new Date();
      if (
        windowDays <= 0 ||
        now.getTime() > refundDeadline(current.settledAt, windowDays).getTime()
      ) {
        throw refundNotAllowed(WINDOW_CLOSED);
      }
      if (current.bankTranId === null) throw refundNotAllowed(NO_BANK_ID);

      const open = await tx.paymentRefund.findFirst({
        where: { attemptId: attempt.id, status: { in: OPEN_REFUND_STATUSES } },
        select: { id: true },
      });
      if (open) throw refundNotAllowed(ALREADY_OPEN);

      const refundable = await refundableAmount(tx, {
        id: attempt.id,
        feeAmount: current.feeAmount,
      });
      if (refundable.isZero()) throw refundNotAllowed(ALREADY_REFUNDED);

      await tx.paymentRefund.create({
        data: {
          attemptId: attempt.id,
          feeId,
          tutorId: fee.tutorId,
          paymentId: payment.id,
          amount: refundable,
          reason: input.reason,
          source: RefundSource.TUTOR,
          status: RefundStatus.REQUESTED,
          requestedById: accountId,
        },
      });
    });
  } catch (err) {
    if (isOpenRefundConflict(err)) throw refundNotAllowed(ALREADY_OPEN);
    throw err;
  }

  return getMyFee(accountId, feeId);
}
