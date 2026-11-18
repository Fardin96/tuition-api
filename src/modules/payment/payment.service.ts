import type { FastifyBaseLogger } from "fastify";
import { env } from "../../config/env.js";
import type { PaymentAttempt } from "../../generated/prisma/client.js";
import { Prisma } from "../../generated/prisma/client.js";
import { FeeStatus, PaymentAttemptStatus } from "../../generated/prisma/enums.js";
import { type AppError, appError, ERROR_CODES, notFound } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import {
  GatewayError,
  type GatewayTransaction,
  getPaymentGateway,
  isSuccessStatus,
  paymentsConfigured,
} from "../../lib/sslcommerz.js";
import { MIN_ONLINE_TOTAL, newTranId, quoteFor, readPaymentSettings } from "../fees/fee-quote.js";
import type { CheckoutSession, PaymentAttemptView } from "./payment.schema.js";

type Tx = Prisma.TransactionClient;

const OPEN_STATUSES: FeeStatus[] = [FeeStatus.DUE, FeeStatus.PARTIAL];
// Only these source states can move to SUCCEEDED. SUCCEEDED, REVIEW and UNAPPLIED are final here.
export const SETTLABLE: PaymentAttemptStatus[] = [
  PaymentAttemptStatus.PENDING,
  PaymentAttemptStatus.FAILED,
  PaymentAttemptStatus.CANCELLED,
  PaymentAttemptStatus.EXPIRED,
];

const MINUTE_MS = 60_000;
// Read-path reconcile: a PENDING attempt older than this, checked at most this often.
const STALE_PENDING_MS = 5_000;
const RECHECK_EVERY_MS = 10_000;
// A PENDING attempt the gateway has never heard of after this long is given up.
const ABANDON_AFTER_MS = 60 * MINUTE_MS;

const PENDING_INDEX = "payment_attempt_one_pending_per_fee";

function paymentsDisabled(): AppError {
  return appError("PaymentsDisabled", 503, "Online payments are turned off right now.");
}

function gatewayUnavailable(): AppError {
  return appError(
    "GatewayUnavailable",
    503,
    "The payment gateway isn't responding. Try again in a few minutes.",
  );
}

function invalidFee(message: string): AppError {
  return appError("InvalidFeeState", 409, message);
}

function remainingOf(fee: { amountDue: Prisma.Decimal; amountPaid: Prisma.Decimal }) {
  return fee.amountDue.minus(fee.amountPaid);
}

function sumOf(amounts: Prisma.Decimal[]): Prisma.Decimal {
  return amounts.reduce((sum, a) => sum.plus(a), new Prisma.Decimal(0));
}

function decimalOrNull(value: string): Prisma.Decimal | null {
  try {
    return new Prisma.Decimal(value);
  } catch {
    return null;
  }
}

function apiUrl(path: string): string {
  const base = env.API_PUBLIC_URL?.replace(/\/+$/, "");
  if (!base) throw paymentsDisabled();
  return `${base}/api/v1/payments/sslcommerz/${path}`;
}

export async function lockFee(tx: Tx, feeId: string) {
  await tx.$queryRaw`SELECT id FROM platform_fee WHERE id = ${feeId}::uuid FOR UPDATE`;
}

export async function lockAttempt(tx: Tx, attemptId: string) {
  await tx.$queryRaw`SELECT id FROM payment_attempt WHERE id = ${attemptId}::uuid FOR UPDATE`;
}

// The one-PENDING-per-fee index refuses a second checkout. Prisma reports it as P2002; some driver
// paths surface the raw Postgres error (code 23505 or "unique_violation") instead.
export function isPendingConflict(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return true;
  let current: unknown = err;
  for (let depth = 0; depth < 5; depth++) {
    if (typeof current !== "object" || current === null) break;
    const e = current as {
      message?: unknown;
      originalMessage?: unknown;
      originalCode?: unknown;
      cause?: unknown;
    };
    const texts = [e.message, e.originalMessage].filter((t): t is string => typeof t === "string");
    if (texts.some((t) => t.includes(PENDING_INDEX) || t.includes("unique_violation"))) return true;
    current = e.cause;
  }
  return false;
}

function isGatewayUnreachable(err: unknown): boolean {
  if (err instanceof GatewayError) return true;
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    err.code === ERROR_CODES.PaymentsDisabled
  );
}

// The fee must belong to the caller's tutor profile. Another tutor's fee looks like no fee at all.
async function ownedFee(accountId: string, feeId: string) {
  const tutor = await prisma.tutor.findUnique({
    where: { accountId },
    select: {
      id: true,
      name: true,
      phoneNumber: true,
      account: { select: { email: true } },
    },
  });
  const fee = tutor ? await loadFee(feeId) : null;
  if (!tutor || !fee || fee.tutorId !== tutor.id) {
    throw notFound("Fee not found");
  }
  return { tutor, fee };
}

const feeSelect = {
  tutorId: true,
  status: true,
  amountDue: true,
  amountPaid: true,
} satisfies Prisma.PlatformFeeSelect;

function loadFee(feeId: string) {
  return prisma.platformFee.findUnique({ where: { id: feeId }, select: feeSelect });
}

// Ends a PENDING attempt only. Any other state is left alone, so a verified success is never undone.
async function endPending(
  tranId: string,
  status: "FAILED" | "CANCELLED" | "EXPIRED",
  reason: string,
) {
  await prisma.paymentAttempt.updateMany({
    where: { tranId, status: "PENDING" },
    data: { status, failureReason: reason },
  });
}

export async function markAttempt(
  tranId: string,
  status: "FAILED" | "CANCELLED",
  reason: string,
): Promise<void> {
  await endPending(tranId, status, reason);
}

// A payment in REVIEW may still be added to the fee. A second checkout or a promo change before
// it is decided would charge the tutor twice or leave the reviewed payment over the amount due.
export async function refuseIfInReview(db: Tx, feeId: string, message: string): Promise<void> {
  const inReview = await db.paymentAttempt.findFirst({
    where: { feeId, status: PaymentAttemptStatus.REVIEW },
    select: { id: true },
  });
  if (inReview) throw invalidFee(message);
}

export const IN_REVIEW_CHECKOUT =
  "A payment for this fee is being checked. Wait for the result before paying again.";

export async function feeIdOfAttempt(tranId: string): Promise<string | null> {
  const row = await prisma.paymentAttempt.findUnique({
    where: { tranId },
    select: { feeId: true },
  });
  return row?.feeId ?? null;
}

/**
 * Settles or gives up the fee's PENDING checkout before something changes what the tutor owes
 * (a new checkout, a promo code). Asks the gateway first: a payment that just went through is
 * posted, and the caller gets 409 "This fee was just paid." Otherwise the attempt is EXPIRED
 * with `reason`. A late success on it still settles (or lands in UNAPPLIED if it no longer fits).
 * Gateway trouble is 503 GATEWAY_UNAVAILABLE. Call it outside any transaction.
 */
export async function clearPendingAttempt(feeId: string, reason: string): Promise<void> {
  const pending = await prisma.paymentAttempt.findFirst({
    where: { feeId, status: "PENDING" },
    select: { tranId: true },
  });
  if (!pending) return;
  try {
    await reconcileAttempt(pending.tranId);
  } catch (err) {
    if (isGatewayUnreachable(err)) throw gatewayUnavailable();
    throw err;
  }
  const after = await loadFee(feeId);
  if (!after) throw notFound("Fee not found");
  if (after.status === FeeStatus.PAID) throw invalidFee("This fee was just paid.");
  if (!OPEN_STATUSES.includes(after.status) || remainingOf(after).lessThanOrEqualTo(0)) {
    throw invalidFee("This fee is not open for online payment.");
  }
  await endPending(pending.tranId, "EXPIRED", reason);
}

export async function startCheckout(accountId: string, feeId: string): Promise<CheckoutSession> {
  // 1. Kill switch and configuration.
  const settings = await readPaymentSettings(prisma);
  if (!settings.enabled || !paymentsConfigured()) throw paymentsDisabled();
  const gateway = getPaymentGateway();

  // 2. Owner, state and remaining amount.
  const { tutor, fee } = await ownedFee(accountId, feeId);
  if (!OPEN_STATUSES.includes(fee.status) || remainingOf(fee).lessThanOrEqualTo(0)) {
    throw invalidFee("This fee is not open for online payment.");
  }

  await refuseIfInReview(prisma, feeId, IN_REVIEW_CHECKOUT);

  // 3. A PENDING checkout must be settled or given up before a new one starts.
  await clearPendingAttempt(feeId, "Replaced by a new checkout");

  // 4. Quote and insert the PENDING attempt under the fee lock.
  const urls = {
    success: apiUrl("success"),
    fail: apiUrl("fail"),
    cancel: apiUrl("cancel"),
    ipn: apiUrl("ipn"),
  };
  const created = await prisma
    .$transaction(async (tx) => {
      await lockFee(tx, feeId);
      const locked = await tx.platformFee.findUnique({ where: { id: feeId }, select: feeSelect });
      if (
        !locked ||
        !OPEN_STATUSES.includes(locked.status) ||
        remainingOf(locked).lessThanOrEqualTo(0)
      ) {
        throw invalidFee("This fee is not open for online payment.");
      }
      // Re-checked under the fee lock: a review decision locks the fee first too.
      await refuseIfInReview(tx, feeId, IN_REVIEW_CHECKOUT);
      const current = await readPaymentSettings(tx);
      const quote = quoteFor(remainingOf(locked), current.chargePercent);
      if (quote.totalAmount.lessThan(MIN_ONLINE_TOTAL)) {
        throw invalidFee("Online payments start at ৳10. Pay the rest in cash.");
      }
      const attempt = await tx.paymentAttempt.create({
        data: {
          feeId,
          tutorId: locked.tutorId,
          tranId: newTranId(),
          feeAmount: quote.feeAmount.toFixed(2),
          chargeAmount: quote.chargeAmount.toFixed(2),
          totalAmount: quote.totalAmount.toFixed(2),
        },
      });
      return { tranId: attempt.tranId, quote };
    })
    .catch((err: unknown) => {
      if (isPendingConflict(err)) {
        throw invalidFee("A payment for this fee is already in progress.");
      }
      throw err;
    });

  const { tranId, quote } = created;
  const feeAmount = quote.feeAmount.toFixed(2);
  const chargeAmount = quote.chargeAmount.toFixed(2);
  const totalAmount = quote.totalAmount.toFixed(2);

  // 5. Create the gateway session outside any transaction.
  let session: { sessionKey: string; gatewayUrl: string };
  try {
    session = await gateway.createSession({
      tranId,
      totalAmount,
      productName: "Placement fee",
      customer: {
        name: tutor.name,
        email: tutor.account.email,
        phone: tutor.phoneNumber,
        city: "Dhaka",
      },
      urls,
      valueA: feeId,
    });
  } catch (err) {
    if (err instanceof GatewayError) {
      await endPending(tranId, "FAILED", `Session ${err.kind}: ${err.message}`);
      throw gatewayUnavailable();
    }
    await endPending(tranId, "FAILED", "Session could not be created");
    throw err;
  }

  await prisma.paymentAttempt.update({
    where: { tranId },
    data: { sessionKey: session.sessionKey },
  });

  return {
    tranId,
    gatewayUrl: session.gatewayUrl,
    feeAmount,
    chargeAmount,
    totalAmount,
  };
}

// Mismatches that send a verified-looking success to REVIEW instead of the ledger.
function reviewReasons(v: GatewayTransaction, total: Prisma.Decimal): string[] {
  const reasons: string[] = [];
  if (v.currencyType !== "BDT") {
    reasons.push(`Gateway currency is ${v.currencyType || "missing"}, not BDT`);
  }
  const gatewayAmount = v.currencyAmount || v.amount;
  const paid = decimalOrNull(gatewayAmount);
  if (!paid?.equals(total)) {
    reasons.push(
      `Gateway amount ${gatewayAmount.slice(0, 20) || "missing"} differs from ${total.toFixed(2)}`,
    );
  }
  if (v.riskLevel === 1) reasons.push("Gateway flagged the payment as risky (risk level 1)");
  return reasons;
}

// The same rules fee_payment_before_insert enforces, checked first so the attempt can be UNAPPLIED.
export async function ledgerBlock(
  tx: Tx,
  fee: { status: FeeStatus; amountDue: Prisma.Decimal; amountPaid: Prisma.Decimal },
  feeAmount: Prisma.Decimal,
  tranId: string,
): Promise<string | null> {
  if (fee.status === FeeStatus.WAIVED || fee.status === FeeStatus.VOID) {
    return `The fee is ${fee.status}, so the payment was not applied. Needs a refund.`;
  }
  if (fee.amountPaid.plus(feeAmount).greaterThan(fee.amountDue)) {
    return "The payment is more than the amount still due on the fee. Needs a refund.";
  }
  const earlier = await tx.feePayment.findMany({
    where: { kind: "PAYMENT", method: "SSLCOMMERZ", txnReference: tranId },
    select: { amount: true, reversals: { select: { amount: true } } },
  });
  const taken = earlier.some((p) => p.amount.greaterThan(sumOf(p.reversals.map((r) => r.amount))));
  if (taken) return "This gateway transaction is already on the ledger. Needs a refund.";
  return null;
}

// Verifies a gateway success and posts it to the ledger once. Idempotent: the same success from the
// redirect, the IPN and reconcile produces one fee_payment row.
export async function settleAttempt(tranId: string, valId: string): Promise<PaymentAttempt | null> {
  const gateway = getPaymentGateway();
  // 1. The gateway's validate answer is the only source of truth. Outside any transaction.
  const v = await gateway.validate(valId);

  // A val_id that the gateway ties to another tran_id (or to none) says nothing about this attempt.
  // Acting on it would let anyone with a foreign val_id move a victim's attempt, so leave it alone.
  if (v.tranId !== tranId) {
    return prisma.paymentAttempt.findUnique({ where: { tranId } });
  }

  // 2. The gateway confirms this transaction is not a success: a soft end state, only from PENDING.
  if (!isSuccessStatus(v.status)) {
    await endPending(tranId, "FAILED", `Gateway status ${v.status}`);
    return prisma.paymentAttempt.findUnique({ where: { tranId } });
  }

  // 3. Find the fee id without a lock. The lock order is fixed below.
  const found = await prisma.paymentAttempt.findUnique({
    where: { tranId },
    select: { id: true, feeId: true },
  });
  if (!found) return null;

  // 4-7. One transaction: fee lock, then attempt lock, then the checks and the ledger row.
  return prisma.$transaction(async (tx) => {
    await lockFee(tx, found.feeId);
    await lockAttempt(tx, found.id);
    const attempt = await tx.paymentAttempt.findUniqueOrThrow({ where: { id: found.id } });
    if (!SETTLABLE.includes(attempt.status)) return attempt;

    const gatewayFields = {
      valId,
      bankTranId: v.bankTranId,
      cardType: v.cardType,
      riskLevel: v.riskLevel,
      gatewayResponse: v.raw as Prisma.InputJsonObject,
    };

    // 5. Mismatch checks: the gateway says paid, but not the way we expect.
    const reasons = reviewReasons(v, attempt.totalAmount);
    if (reasons.length > 0) {
      return tx.paymentAttempt.update({
        where: { id: attempt.id },
        data: {
          ...gatewayFields,
          status: PaymentAttemptStatus.REVIEW,
          failureReason: reasons.join("; "),
        },
      });
    }

    // 6. Ledger pre-check under the fee lock.
    const fee = await tx.platformFee.findUniqueOrThrow({
      where: { id: attempt.feeId },
      select: { status: true, amountDue: true, amountPaid: true },
    });
    const blocked = await ledgerBlock(tx, fee, attempt.feeAmount, tranId);
    if (blocked) {
      return tx.paymentAttempt.update({
        where: { id: attempt.id },
        data: { ...gatewayFields, status: PaymentAttemptStatus.UNAPPLIED, failureReason: blocked },
      });
    }

    // 7. Post the fee part only. The charge is not ledger revenue.
    const payment = await tx.feePayment.create({
      data: {
        feeId: attempt.feeId,
        kind: "PAYMENT",
        amount: attempt.feeAmount,
        method: "SSLCOMMERZ",
        txnReference: tranId,
        receivedAt: new Date(),
        recordedById: null,
      },
    });
    return tx.paymentAttempt.update({
      where: { id: attempt.id },
      data: {
        ...gatewayFields,
        status: PaymentAttemptStatus.SUCCEEDED,
        paymentId: payment.id,
        failureReason: null,
        settledAt: new Date(),
      },
    });
  });
}

// Asks the gateway about a PENDING attempt. GatewayError propagates. last_checked_at is always set.
// The real sandbox answers a session the tutor opened but never paid with PROCESSING, PENDING,
// INITIATED or UNATTEMPTED, so those are not "still going" evidence on their own:
// - a verified success settles (SETTLABLE, so an EXPIRED attempt can still settle later);
// - FAILED or CANCELLED is a soft end state;
// - EXPIRED or UNATTEMPTED ends the attempt at once;
// - no element, or only non-final statuses, ends it once it is older than ABANDON_AFTER_MS.
export async function reconcileAttempt(tranId: string): Promise<void> {
  const gateway = getPaymentGateway();
  const attempt = await prisma.paymentAttempt.findUnique({
    where: { tranId },
    select: { createdAt: true },
  });
  if (!attempt) return;

  try {
    const results = await gateway.queryByTranId(tranId);
    const verified = results.find((r) => isSuccessStatus(r.status) && r.valId);
    const ended = results.find((r) => r.status === "FAILED" || r.status === "CANCELLED");
    const abandoned = results.find((r) => r.status === "EXPIRED" || r.status === "UNATTEMPTED");
    if (verified?.valId) {
      await settleAttempt(tranId, verified.valId);
    } else if (ended) {
      await markAttempt(
        tranId,
        ended.status === "CANCELLED" ? "CANCELLED" : "FAILED",
        `Gateway status ${ended.status}`,
      );
    } else if (abandoned) {
      await endPending(tranId, "EXPIRED", `Gateway status ${abandoned.status}`);
    } else if (attempt.createdAt.getTime() < Date.now() - ABANDON_AFTER_MS) {
      await endPending(tranId, "EXPIRED", "No completed payment at the gateway after 60 minutes");
    }
  } finally {
    await prisma.paymentAttempt.updateMany({
      where: { tranId },
      data: { lastCheckedAt: new Date() },
    });
  }
}

const attemptSelect = {
  id: true,
  feeId: true,
  tranId: true,
  status: true,
  feeAmount: true,
  chargeAmount: true,
  totalAmount: true,
  failureReason: true,
  createdAt: true,
  settledAt: true,
  lastCheckedAt: true,
} satisfies Prisma.PaymentAttemptSelect;

async function findOwnedAttempt(feeId: string, tranId: string) {
  const attempt = await prisma.paymentAttempt.findUnique({
    where: { tranId },
    select: attemptSelect,
  });
  if (!attempt || attempt.feeId !== feeId) throw notFound("Payment not found");
  return attempt;
}

function isStale(attempt: { createdAt: Date; lastCheckedAt: Date | null }): boolean {
  const now = Date.now();
  return (
    now - attempt.createdAt.getTime() > STALE_PENDING_MS &&
    (attempt.lastCheckedAt === null || now - attempt.lastCheckedAt.getTime() > RECHECK_EVERY_MS)
  );
}

export async function getAttemptView(
  accountId: string,
  feeId: string,
  tranId: string,
  log?: FastifyBaseLogger,
): Promise<PaymentAttemptView> {
  await ownedFee(accountId, feeId);
  let attempt = await findOwnedAttempt(feeId, tranId);

  // Reconcile on read, so a paid tutor sees the result without waiting for the redirect or IPN.
  if (attempt.status === PaymentAttemptStatus.PENDING && isStale(attempt)) {
    try {
      await reconcileAttempt(tranId);
    } catch (err) {
      if (!isGatewayUnreachable(err)) throw err;
      log?.warn({ err, tranId }, "Could not reconcile a pending payment on read");
    }
    attempt = await findOwnedAttempt(feeId, tranId);
  }

  const fee = await loadFee(feeId);
  if (!fee) throw notFound("Fee not found");
  return {
    tranId: attempt.tranId,
    status: attempt.status,
    feeAmount: attempt.feeAmount.toFixed(2),
    chargeAmount: attempt.chargeAmount.toFixed(2),
    totalAmount: attempt.totalAmount.toFixed(2),
    failureReason: attempt.failureReason,
    createdAt: attempt.createdAt,
    settledAt: attempt.settledAt,
    fee: {
      status: fee.status,
      amountDue: fee.amountDue.toFixed(2),
      amountPaid: fee.amountPaid.toFixed(2),
      remaining: remainingOf(fee).toFixed(2),
    },
  };
}
