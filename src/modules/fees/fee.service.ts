import { Prisma } from "../../generated/prisma/client.js";
import { FeeStatus, RefundStatus } from "../../generated/prisma/enums.js";
import { decodeCursor, encodeCursor } from "../../lib/cursor.js";
import { notFound } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { paymentsConfigured } from "../../lib/sslcommerz.js";
import { dhakaToday } from "../admin/fees.service.js";
import { FEE_UNPAID_AFTER_DAYS } from "../application/application.schema.js";
import { toTutorRefund, tutorRefundSelect } from "../refunds/refund.schema.js";
import {
  OPEN_REFUND_STATUSES,
  readRefundWindowDays,
  refundDeadline,
} from "../refunds/refund-rules.js";
import type {
  CheckoutQuoteResponse,
  TutorFeeDetailResponse,
  TutorFeePageResponse,
  TutorFeeResponse,
} from "./fee.schema.js";
import { MIN_ONLINE_TOTAL, quoteFor, readPaymentSettings } from "./fee-quote.js";
import { feePromoOf } from "./promo.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 50;
const OPEN_FEE_STATUSES: FeeStatus[] = [FeeStatus.DUE, FeeStatus.PARTIAL];
const TUTOR_PROFILE_NOT_FOUND = "Tutor profile not found";
const FEE_NOT_FOUND = "Fee not found";

// Default-deny: only these columns leave the API. The recorder and txnReference stay server-side.
const feeSelect = {
  id: true,
  feeType: true,
  status: true,
  amountDue: true,
  amountPaid: true,
  dueDate: true,
  createdAt: true,
  application: {
    select: {
      id: true,
      confirmedAt: true,
      packageId: true,
      package: { select: { title: true } },
      student: { select: { name: true } },
    },
  },
} satisfies Prisma.PlatformFeeSelect;

const paymentSelect = {
  id: true,
  kind: true,
  amount: true,
  method: true,
  receivedAt: true,
  reversesPaymentId: true,
} satisfies Prisma.FeePaymentSelect;

// The attempt behind each online payment, with its refunds: enough to tell whether one can still be refunded.
const attemptSelect = {
  paymentId: true,
  status: true,
  feeAmount: true,
  bankTranId: true,
  settledAt: true,
  refunds: { select: { status: true, amount: true } },
} satisfies Prisma.PaymentAttemptSelect;

// Refunds that count against the fee part of a payment: open ones and succeeded ones.
const COUNTED_REFUND_STATUSES: RefundStatus[] = [...OPEN_REFUND_STATUSES, RefundStatus.SUCCEEDED];

type FeeRow = Prisma.PlatformFeeGetPayload<{ select: typeof feeSelect }>;
type AttemptRow = Prisma.PaymentAttemptGetPayload<{ select: typeof attemptSelect }>;
type PaymentRow = Prisma.FeePaymentGetPayload<{ select: typeof paymentSelect }>;

const detailSelect = {
  ...feeSelect,
  payments: {
    orderBy: [{ receivedAt: "asc" }, { createdAt: "asc" }],
    select: paymentSelect,
  },
  promoRedemptions: {
    where: { status: "ACTIVE" },
    take: 1,
    select: {
      createdAt: true,
      originalAmount: true,
      discountAmount: true,
      promo: { select: { code: true } },
    },
  },
} satisfies Prisma.PlatformFeeSelect;

function toTutorFee(row: FeeRow, today: string, now: Date): TutorFeeResponse {
  const open = OPEN_FEE_STATUSES.includes(row.status);
  const dueDate = row.dueDate.toISOString().slice(0, 10);
  const { confirmedAt } = row.application;
  return {
    id: row.id,
    feeType: row.feeType,
    status: row.status,
    amountDue: row.amountDue.toFixed(2),
    amountPaid: row.amountPaid.toFixed(2),
    remaining: row.amountDue.minus(row.amountPaid).toFixed(2),
    dueDate,
    overdue: open && dueDate < today,
    unpaid:
      open &&
      confirmedAt !== null &&
      confirmedAt.getTime() + FEE_UNPAID_AFTER_DAYS * DAY_MS < now.getTime(),
    createdAt: row.createdAt,
    application: {
      id: row.application.id,
      kind: row.application.packageId ? "PACKAGE" : "REQUIREMENT",
      confirmedAt,
      packageTitle: row.application.package?.title ?? null,
      studentName: row.application.student.name,
    },
  };
}

// The last moment the tutor can ask for a refund of this payment, or null when they cannot. Only an
// SSLCommerz payment whose attempt succeeded with a bank transaction id, inside the window, with
// fee part left to refund and no refund already open. Mirrors the checks in requestRefund.
function refundableUntilOf(
  payment: Pick<PaymentRow, "id" | "kind" | "method">,
  attempt: AttemptRow | undefined,
  windowDays: number,
  now: Date,
): Date | null {
  if (payment.kind !== "PAYMENT" || payment.method !== "SSLCOMMERZ" || !attempt) return null;
  if (attempt.status !== "SUCCEEDED" || attempt.settledAt === null || attempt.bankTranId === null) {
    return null;
  }
  if (windowDays <= 0) return null;
  const until = refundDeadline(attempt.settledAt, windowDays);
  if (now.getTime() > until.getTime()) return null;
  if (attempt.refunds.some((r) => OPEN_REFUND_STATUSES.includes(r.status))) return null;
  const counted = attempt.refunds
    .filter((r) => COUNTED_REFUND_STATUSES.includes(r.status))
    .reduce((sum, r) => sum.plus(r.amount), new Prisma.Decimal(0));
  return attempt.feeAmount.greaterThan(counted) ? until : null;
}

// Quotes the tutor's remaining balance. Null when there is nothing to pay online.
async function checkoutFor(
  row: Pick<FeeRow, "status" | "amountDue" | "amountPaid">,
): Promise<CheckoutQuoteResponse | null> {
  const remaining = row.amountDue.minus(row.amountPaid);
  if (!OPEN_FEE_STATUSES.includes(row.status) || remaining.lessThanOrEqualTo(0)) return null;

  const settings = await readPaymentSettings(prisma);
  const quote = quoteFor(remaining, settings.chargePercent);
  const unavailableReason: CheckoutQuoteResponse["unavailableReason"] =
    !settings.enabled || !paymentsConfigured()
      ? "PAYMENTS_OFF"
      : quote.totalAmount.lessThan(MIN_ONLINE_TOTAL)
        ? "BELOW_MINIMUM"
        : null;

  return {
    enabled: unavailableReason === null,
    unavailableReason,
    feeAmount: quote.feeAmount.toFixed(2),
    chargePercent: quote.chargePercent.toFixed(2),
    chargeAmount: quote.chargeAmount.toFixed(2),
    totalAmount: quote.totalAmount.toFixed(2),
  };
}

// The caller's fees, newest first. Keyset over (createdAt desc, id desc).
export async function listMyFees(
  accountId: string,
  cursor: string | undefined,
): Promise<TutorFeePageResponse> {
  const tutor = await prisma.tutor.findUnique({ where: { accountId }, select: { id: true } });
  if (!tutor) throw notFound(TUTOR_PROFILE_NOT_FOUND);

  const clauses: Prisma.PlatformFeeWhereInput[] = [{ tutorId: tutor.id }];
  if (cursor) {
    const decoded = decodeCursor(cursor);
    clauses.push({
      OR: [
        { createdAt: { lt: decoded.createdAt } },
        { createdAt: decoded.createdAt, id: { lt: decoded.id } },
      ],
    });
  }

  const rows = await prisma.platformFee.findMany({
    where: { AND: clauses },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: PAGE_SIZE + 1,
    select: feeSelect,
  });

  const hasMore = rows.length > PAGE_SIZE;
  const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
  const last = page[page.length - 1];
  const today = dhakaToday();
  const now = new Date();

  return {
    fees: page.map((row) => toTutorFee(row, today, now)),
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
  };
}

// Owner only: another tutor's fee is indistinguishable from a missing one.
export async function getMyFee(accountId: string, feeId: string): Promise<TutorFeeDetailResponse> {
  const row = await prisma.platformFee.findFirst({
    where: { id: feeId, tutor: { accountId } },
    select: detailSelect,
  });
  if (!row) throw notFound(FEE_NOT_FOUND);

  const attempt = await prisma.paymentAttempt.findFirst({
    where: { feeId: row.id, status: "PENDING" },
    select: { tranId: true, createdAt: true },
  });
  const promo = feePromoOf(row.promoRedemptions[0]);

  const now = new Date();
  const onlineAttempts = await prisma.paymentAttempt.findMany({
    where: { feeId: row.id, paymentId: { not: null } },
    select: attemptSelect,
  });
  const attemptByPayment = new Map(onlineAttempts.map((a) => [a.paymentId, a] as const));
  const windowDays = await readRefundWindowDays(prisma);
  const refunds = await prisma.paymentRefund.findMany({
    where: { feeId: row.id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: tutorRefundSelect,
  });

  return {
    ...toTutorFee(row, dhakaToday(), now),
    payments: row.payments.map((p) => ({
      id: p.id,
      kind: p.kind,
      amount: p.amount.toFixed(2),
      method: p.method,
      receivedAt: p.receivedAt,
      reversesPaymentId: p.reversesPaymentId,
      refundableUntil: refundableUntilOf(p, attemptByPayment.get(p.id), windowDays, now),
    })),
    refunds: refunds.map((r) => toTutorRefund(r)),
    checkout: await checkoutFor(row),
    pendingAttempt: attempt ? { tranId: attempt.tranId, createdAt: attempt.createdAt } : null,
    promo,
    promoAllowed: row.status === FeeStatus.DUE && row.amountPaid.isZero() && promo === null,
  } satisfies TutorFeeDetailResponse;
}
