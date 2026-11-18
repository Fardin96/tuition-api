// Settles PENDING payments that the redirect and the IPN never reported (closed tab, lost callback).
// Each attempt goes through reconcileAttempt, the same path as the tutor's read-side check, so a cron
// run and a page view cannot post a payment twice.

import { ERROR_CODES } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { GatewayError, paymentsConfigured } from "../../lib/sslcommerz.js";
import { reconcileAttempt } from "./payment.service.js";

// Give the redirect and the IPN time to land before asking the gateway.
const SETTLE_GRACE_MS = 2 * 60_000;
// Never ask the gateway about the same attempt more often than this.
const RECHECK_EVERY_MS = 5 * 60_000;
// Consecutive gateway failures before the run stops, on the assumption that the gateway is down.
const MAX_CONSECUTIVE_GATEWAY_ERRORS = 3;

export type ReconcileOptions = {
  now?: Date;
  limit?: number;
  log?: (msg: string) => void;
};

// checked = settled + review + unapplied + ended + stillPending + gatewayErrors + failed.
export type ReconcileResult = {
  skipped: boolean;
  checked: number;
  settled: number;
  review: number;
  unapplied: number;
  ended: number;
  stillPending: number;
  gatewayErrors: number;
  failed: number;
  aborted: boolean;
};

function emptyResult(): ReconcileResult {
  return {
    skipped: false,
    checked: 0,
    settled: 0,
    review: 0,
    unapplied: 0,
    ended: 0,
    stillPending: 0,
    gatewayErrors: 0,
    failed: 0,
    aborted: false,
  };
}

// Same rule as the read path in payment.service: the gateway is unreachable or refuses the query.
function isGatewayDown(err: unknown): boolean {
  if (err instanceof GatewayError) return true;
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    err.code === ERROR_CODES.PaymentsDisabled
  );
}

// Runs even when online_payments_enabled is off: payments already in flight must still settle.
export async function runPaymentReconcile(opts: ReconcileOptions = {}): Promise<ReconcileResult> {
  if (!paymentsConfigured()) return { ...emptyResult(), skipped: true };

  const now = opts.now ?? new Date();
  const log = opts.log ?? (() => {});
  const result = emptyResult();

  const attempts = await prisma.paymentAttempt.findMany({
    where: {
      status: "PENDING",
      createdAt: { lt: new Date(now.getTime() - SETTLE_GRACE_MS) },
      OR: [
        { lastCheckedAt: null },
        { lastCheckedAt: { lt: new Date(now.getTime() - RECHECK_EVERY_MS) } },
      ],
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: opts.limit ?? 100,
    select: { tranId: true },
  });

  let consecutiveErrors = 0;
  for (const { tranId } of attempts) {
    result.checked++;
    try {
      await reconcileAttempt(tranId);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // Only this attempt is skipped; it stays PENDING and the next run tries it again.
      if (!isGatewayDown(err)) {
        result.failed++;
        log(`payment-reconcile: error on ${tranId}: ${reason}`);
        continue;
      }
      result.gatewayErrors++;
      consecutiveErrors++;
      log(`payment-reconcile: gateway error on ${tranId}: ${reason}`);
      if (consecutiveErrors >= MAX_CONSECUTIVE_GATEWAY_ERRORS) {
        result.aborted = true;
        log(`payment-reconcile: stopping after ${consecutiveErrors} gateway errors in a row`);
        break;
      }
      continue;
    }
    consecutiveErrors = 0;

    const { status } = await prisma.paymentAttempt.findUniqueOrThrow({
      where: { tranId },
      select: { status: true },
    });
    switch (status) {
      case "SUCCEEDED":
        result.settled++;
        break;
      case "REVIEW":
        result.review++;
        break;
      case "UNAPPLIED":
        result.unapplied++;
        break;
      case "FAILED":
      case "CANCELLED":
      case "EXPIRED":
        result.ended++;
        break;
      case "PENDING":
        result.stillPending++;
        break;
    }
  }

  return result;
}
