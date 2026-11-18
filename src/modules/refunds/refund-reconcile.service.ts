// Moves refunds the gateway is still working on to their final state. A refund in PROCESSING is
// checked with the gateway every 30 minutes. One whose process died before the gateway answered
// (no reference, untouched for 10 minutes) goes to NEEDS_REVIEW, because nobody knows whether it
// was sent. Admin actions are never touched here: checkRefund with a null actor is the only write.

import { RefundStatus } from "../../generated/prisma/enums.js";
import { ERROR_CODES } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { GatewayError, paymentsConfigured } from "../../lib/sslcommerz.js";
import { checkRefund, markNoAnswer } from "./refund.service.js";

const CHECK_EVERY_MS = 30 * 60_000;
const NO_ANSWER_AFTER_MS = 10 * 60_000;
// Consecutive gateway failures before the run stops, on the assumption that the gateway is down.
const MAX_CONSECUTIVE_GATEWAY_ERRORS = 3;

export type RefundReconcileOptions = {
  now?: Date;
  limit?: number;
  log?: (msg: string) => void;
};

// checked counts the refunds the run acted on. The status counters describe where each one ended up.
export type RefundReconcileResult = {
  skipped: boolean;
  checked: number;
  succeeded: number;
  failed: number;
  stillProcessing: number;
  needsReview: number;
  gatewayErrors: number;
  errors: number;
  aborted: boolean;
};

function emptyResult(): RefundReconcileResult {
  return {
    skipped: false,
    checked: 0,
    succeeded: 0,
    failed: 0,
    stillProcessing: 0,
    needsReview: 0,
    gatewayErrors: 0,
    errors: 0,
    aborted: false,
  };
}

// The gateway is unreachable (checkRefund maps that to 503), or the request was refused.
function isGatewayDown(err: unknown): boolean {
  if (err instanceof GatewayError) return true;
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err.code === ERROR_CODES.GatewayUnavailable || err.code === ERROR_CODES.PaymentsDisabled)
  );
}

// An admin moved the refund while this run was asking: the row is simply counted where it is now.
function isStateConflict(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    err.code === ERROR_CODES.InvalidRefundState
  );
}

async function tally(result: RefundReconcileResult, refundId: string): Promise<void> {
  const { status } = await prisma.paymentRefund.findUniqueOrThrow({
    where: { id: refundId },
    select: { status: true },
  });
  switch (status) {
    case RefundStatus.SUCCEEDED:
      result.succeeded++;
      break;
    case RefundStatus.FAILED:
      result.failed++;
      break;
    case RefundStatus.PROCESSING:
      result.stillProcessing++;
      break;
    case RefundStatus.NEEDS_REVIEW:
      result.needsReview++;
      break;
  }
}

export async function runRefundReconcile(
  opts: RefundReconcileOptions = {},
): Promise<RefundReconcileResult> {
  if (!paymentsConfigured()) return { ...emptyResult(), skipped: true };

  const now = opts.now ?? new Date();
  const limit = opts.limit ?? 100;
  const log = opts.log ?? (() => {});
  const result = emptyResult();

  // 1. PROCESSING without a gateway reference: no gateway call, just a review flag.
  const orphans = await prisma.paymentRefund.findMany({
    where: {
      status: RefundStatus.PROCESSING,
      refundRefId: null,
      updatedAt: { lt: new Date(now.getTime() - NO_ANSWER_AFTER_MS) },
    },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take: limit,
    select: { id: true },
  });
  for (const { id } of orphans) {
    result.checked++;
    try {
      await markNoAnswer(id, new Date(now.getTime() - NO_ANSWER_AFTER_MS));
    } catch (err) {
      result.errors++;
      log(`refund-reconcile: error on ${id}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    await tally(result, id);
  }

  // 2. PROCESSING with a gateway reference, not checked in the last 30 minutes.
  const due = await prisma.paymentRefund.findMany({
    where: {
      status: RefundStatus.PROCESSING,
      refundRefId: { not: null },
      OR: [
        { lastCheckedAt: null },
        { lastCheckedAt: { lt: new Date(now.getTime() - CHECK_EVERY_MS) } },
      ],
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: limit,
    select: { id: true },
  });

  let consecutiveErrors = 0;
  for (const { id } of due) {
    result.checked++;
    try {
      await checkRefund(id, null);
    } catch (err) {
      if (isGatewayDown(err)) {
        result.gatewayErrors++;
        consecutiveErrors++;
        log(
          `refund-reconcile: gateway error on ${id}: ${err instanceof Error ? err.message : String(err)}`,
        );
        if (consecutiveErrors >= MAX_CONSECUTIVE_GATEWAY_ERRORS) {
          result.aborted = true;
          log(`refund-reconcile: stopping after ${consecutiveErrors} gateway errors in a row`);
          break;
        }
        continue;
      }
      if (!isStateConflict(err)) {
        result.errors++;
        log(
          `refund-reconcile: error on ${id}: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
    }
    consecutiveErrors = 0;
    await tally(result, id);
  }

  return result;
}
