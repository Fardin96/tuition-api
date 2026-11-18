import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import { GatewayError, setPaymentGatewayForTests } from "../../lib/sslcommerz.js";
import { createFakeGateway, createSuperAdmin, createTutorFeeFixture } from "../../tests/helpers.js";
import { newTranId } from "../fees/fee-quote.js";
import { runRefundReconcile } from "./refund-reconcile.service.js";

const MINUTE = 60_000;

const savedEnv = {
  SSLC_STORE_ID: env.SSLC_STORE_ID,
  SSLC_STORE_PASSWORD: env.SSLC_STORE_PASSWORD,
  API_PUBLIC_URL: env.API_PUBLIC_URL,
  WEB_PUBLIC_URL: env.WEB_PUBLIC_URL,
};

let adminAccountId: string;

// A SUCCEEDED online payment with its ledger row; the refund hangs off it.
async function succeededPayment() {
  const fixture = await createTutorFeeFixture(1500);
  const tranId = newTranId();
  const payment = await prisma.feePayment.create({
    data: {
      feeId: fixture.fee.id,
      kind: "PAYMENT",
      amount: "1500.00",
      method: "SSLCOMMERZ",
      txnReference: tranId,
      receivedAt: new Date(),
    },
  });
  const attempt = await prisma.paymentAttempt.create({
    data: {
      feeId: fixture.fee.id,
      tutorId: fixture.tutor.id,
      tranId,
      status: "SUCCEEDED",
      feeAmount: "1500.00",
      chargeAmount: "37.50",
      totalAmount: "1537.50",
      bankTranId: `BANK-${tranId}`,
      paymentId: payment.id,
      settledAt: new Date(),
    },
  });
  return { fixture, attempt, payment };
}

// A PROCESSING refund that the gateway has accepted (refundRefId set), or one that has not been
// answered yet (refundRefId null). updatedAt and lastCheckedAt are set directly, to pick the age.
async function processingRefund(
  data: {
    refundRefId?: string | null;
    lastCheckedAt?: Date | null;
    updatedAt?: Date;
    createdAt?: Date;
    status?: "PROCESSING" | "REQUESTED";
  } = {},
) {
  const p = await succeededPayment();
  return prisma.paymentRefund.create({
    data: {
      attemptId: p.attempt.id,
      feeId: p.fixture.fee.id,
      tutorId: p.fixture.tutor.id,
      paymentId: p.payment.id,
      amount: "1500.00",
      reason: "Duplicate charge",
      source: data.status === "REQUESTED" ? "TUTOR" : "ADMIN",
      status: data.status ?? "PROCESSING",
      requestedById: data.status === "REQUESTED" ? p.fixture.tutorAccount.id : adminAccountId,
      decidedById: data.status === "REQUESTED" ? null : adminAccountId,
      decidedAt: data.status === "REQUESTED" ? null : new Date(),
      refundRefId: data.refundRefId === undefined ? `REF-${newTranId()}` : data.refundRefId,
      lastCheckedAt: data.lastCheckedAt ?? null,
      ...(data.updatedAt ? { updatedAt: data.updatedAt } : {}),
      ...(data.createdAt ? { createdAt: data.createdAt } : {}),
    },
  });
}

function refundedAnswer(refundRefId: string) {
  return {
    status: "refunded",
    refundRefId,
    refundedOn: "2026-11-18 10:00:00",
    errorReason: null,
    raw: {},
  };
}

describe("runRefundReconcile", () => {
  let fake: ReturnType<typeof createFakeGateway>;

  beforeEach(async () => {
    fake = createFakeGateway();
    setPaymentGatewayForTests(fake.gateway);
    env.SSLC_STORE_ID = "store_test";
    env.SSLC_STORE_PASSWORD = "pw_test_secret";
    env.API_PUBLIC_URL = "http://api.test";
    env.WEB_PUBLIC_URL = "http://web.test";
    const admin = await createSuperAdmin();
    adminAccountId = admin.id;
  });

  afterEach(() => {
    setPaymentGatewayForTests(null);
    Object.assign(env, savedEnv);
  });

  it("is skipped when payments are not configured, and touches nothing", async () => {
    env.SSLC_STORE_ID = undefined;
    const refund = await processingRefund({ refundRefId: "REF-SKIP" });
    const queried: string[] = [];
    setPaymentGatewayForTests({
      ...fake.gateway,
      async queryRefund(ref) {
        queried.push(ref);
        return fake.gateway.queryRefund(ref);
      },
    });

    const result = await runRefundReconcile();

    expect(result).toMatchObject({ skipped: true, checked: 0, aborted: false, errors: 0 });
    expect(queried).toHaveLength(0);
    const after = await prisma.paymentRefund.findUniqueOrThrow({ where: { id: refund.id } });
    expect(after.status).toBe("PROCESSING");
    expect(after.lastCheckedAt).toBeNull();
  });

  it("checks PROCESSING refunds not checked in the last 30 minutes, and leaves the recent ones alone", async () => {
    const never = await processingRefund({ refundRefId: "REF-NEVER", lastCheckedAt: null });
    const old = await processingRefund({
      refundRefId: "REF-OLD",
      lastCheckedAt: new Date(Date.now() - 40 * MINUTE),
    });
    const recentCheckedAt = new Date(Date.now() - 5 * MINUTE);
    const recent = await processingRefund({
      refundRefId: "REF-RECENT",
      lastCheckedAt: recentCheckedAt,
    });
    fake.setRefundQuery("REF-NEVER", refundedAnswer("REF-NEVER"));
    fake.setRefundQuery("REF-OLD", refundedAnswer("REF-OLD"));
    const queried: string[] = [];
    setPaymentGatewayForTests({
      ...fake.gateway,
      async queryRefund(ref) {
        queried.push(ref);
        return fake.gateway.queryRefund(ref);
      },
    });

    const result = await runRefundReconcile();

    expect(result).toMatchObject({
      skipped: false,
      checked: 2,
      succeeded: 2,
      aborted: false,
      errors: 0,
    });
    expect(queried.sort()).toEqual(["REF-NEVER", "REF-OLD"]);
    const untouched = await prisma.paymentRefund.findUniqueOrThrow({ where: { id: recent.id } });
    expect(untouched.status).toBe("PROCESSING");
    expect(untouched.lastCheckedAt?.getTime()).toBe(recentCheckedAt.getTime());
    for (const refund of [never, old]) {
      const done = await prisma.paymentRefund.findUniqueOrThrow({ where: { id: refund.id } });
      expect(done.status).toBe("SUCCEEDED");
    }
  });

  it("completes a refund the gateway refunded: one REVERSAL row with no recorder (cron)", async () => {
    const refund = await processingRefund({ refundRefId: "REF-CRON", lastCheckedAt: null });
    fake.setRefundQuery("REF-CRON", refundedAnswer("REF-CRON"));

    await runRefundReconcile();

    const done = await prisma.paymentRefund.findUniqueOrThrow({ where: { id: refund.id } });
    expect(done.status).toBe("SUCCEEDED");
    expect(done.reversalId).not.toBeNull();
    const reversal = await prisma.feePayment.findUniqueOrThrow({
      where: { id: done.reversalId ?? "" },
    });
    expect(reversal).toMatchObject({ kind: "REVERSAL", method: "SSLCOMMERZ", recordedById: null });
    expect(reversal.reason).toBe("Refund REF-CRON");
  });

  it("counts still-processing and cancelled refunds where they end up", async () => {
    const waiting = await processingRefund({ refundRefId: "REF-WAIT", lastCheckedAt: null });
    const cancelled = await processingRefund({ refundRefId: "REF-CANCEL", lastCheckedAt: null });
    fake.setRefundQuery("REF-CANCEL", {
      status: "cancelled",
      refundRefId: "REF-CANCEL",
      refundedOn: null,
      errorReason: "Cancelled by the bank",
      raw: {},
    });

    const result = await runRefundReconcile();

    expect(result).toMatchObject({ checked: 2, stillProcessing: 1, failed: 1, errors: 0 });
    const still = await prisma.paymentRefund.findUniqueOrThrow({ where: { id: waiting.id } });
    expect(still.status).toBe("PROCESSING");
    expect(still.lastCheckedAt).not.toBeNull();
    const failed = await prisma.paymentRefund.findUniqueOrThrow({ where: { id: cancelled.id } });
    expect(failed).toMatchObject({ status: "FAILED", failureReason: "Cancelled by the bank" });
  });

  it("moves a PROCESSING refund with no gateway reference, untouched for 10 minutes, to NEEDS_REVIEW", async () => {
    const orphan = await processingRefund({
      refundRefId: null,
      updatedAt: new Date(Date.now() - 20 * MINUTE),
    });
    const fresh = await processingRefund({ refundRefId: null });

    const result = await runRefundReconcile();

    expect(result).toMatchObject({ checked: 1, needsReview: 1, gatewayErrors: 0, errors: 0 });
    const moved = await prisma.paymentRefund.findUniqueOrThrow({ where: { id: orphan.id } });
    expect(moved).toMatchObject({
      status: "NEEDS_REVIEW",
      failureReason:
        "No answer from the gateway. Check the merchant panel before doing anything else.",
      completedAt: null,
    });
    const stillFresh = await prisma.paymentRefund.findUniqueOrThrow({ where: { id: fresh.id } });
    expect(stillFresh.status).toBe("PROCESSING");
    expect(fake.refunds).toHaveLength(0);
  });

  it("ignores refunds that are not in progress", async () => {
    const requested = await processingRefund({ status: "REQUESTED", refundRefId: null });
    const queried: string[] = [];
    setPaymentGatewayForTests({
      ...fake.gateway,
      async queryRefund(ref) {
        queried.push(ref);
        return fake.gateway.queryRefund(ref);
      },
    });

    const result = await runRefundReconcile();

    expect(result.checked).toBe(0);
    expect(queried).toHaveLength(0);
    const after = await prisma.paymentRefund.findUniqueOrThrow({ where: { id: requested.id } });
    expect(after.status).toBe("REQUESTED");
  });

  it("stops after 3 gateway errors in a row, and leaves the rest unchecked", async () => {
    const base = Date.now() - 10 * MINUTE;
    const refunds = [];
    for (let i = 0; i < 4; i++) {
      refunds.push(
        await processingRefund({
          refundRefId: `REF-DOWN-${i}`,
          lastCheckedAt: null,
          createdAt: new Date(base + i * 1000),
        }),
      );
    }
    let calls = 0;
    setPaymentGatewayForTests({
      ...fake.gateway,
      async queryRefund() {
        calls++;
        throw new GatewayError("unavailable", "Fake gateway down");
      },
    });

    const result = await runRefundReconcile();

    expect(result).toMatchObject({ checked: 3, gatewayErrors: 3, aborted: true, errors: 0 });
    expect(calls).toBe(3);
    const unchecked = await prisma.paymentRefund.count({
      where: { id: { in: refunds.map((r) => r.id) }, lastCheckedAt: null },
    });
    expect(unchecked).toBe(1);
  });

  it("a successful check resets the gateway error streak, so the run carries on", async () => {
    const base = Date.now() - 10 * MINUTE;
    for (let i = 0; i < 5; i++) {
      const ref = `REF-STREAK-${i}`;
      await processingRefund({
        refundRefId: ref,
        lastCheckedAt: null,
        createdAt: new Date(base + i * 1000),
      });
      fake.setRefundQuery(ref, refundedAnswer(ref));
    }
    // Calls 0 and 1 fail, call 2 answers, calls 3 and 4 fail: never three in a row.
    let call = -1;
    setPaymentGatewayForTests({
      ...fake.gateway,
      async queryRefund(ref) {
        call++;
        if (call === 0 || call === 1 || call === 3 || call === 4) {
          throw new GatewayError("unavailable", "Fake gateway down");
        }
        return fake.gateway.queryRefund(ref);
      },
    });

    const result = await runRefundReconcile();

    expect(result).toMatchObject({
      checked: 5,
      gatewayErrors: 4,
      succeeded: 1,
      aborted: false,
      errors: 0,
    });
  });

  it("an unexpected error on one refund is counted and the run carries on", async () => {
    const bad = await processingRefund({ refundRefId: "REF-BAD", lastCheckedAt: null });
    const good = await processingRefund({ refundRefId: "REF-GOOD", lastCheckedAt: null });
    fake.setRefundQuery("REF-GOOD", refundedAnswer("REF-GOOD"));
    setPaymentGatewayForTests({
      ...fake.gateway,
      async queryRefund(ref) {
        if (ref === "REF-BAD") throw new Error("unexpected shape");
        return fake.gateway.queryRefund(ref);
      },
    });

    const result = await runRefundReconcile();

    expect(result).toMatchObject({
      checked: 2,
      errors: 1,
      succeeded: 1,
      aborted: false,
      gatewayErrors: 0,
    });
    const stillOpen = await prisma.paymentRefund.findUniqueOrThrow({ where: { id: bad.id } });
    expect(stillOpen.status).toBe("PROCESSING");
    const done = await prisma.paymentRefund.findUniqueOrThrow({ where: { id: good.id } });
    expect(done.status).toBe("SUCCEEDED");
  });
});
