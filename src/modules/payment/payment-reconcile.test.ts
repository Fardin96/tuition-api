import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import {
  GatewayError,
  type GatewayTransaction,
  type PaymentGateway,
  setPaymentGatewayForTests,
} from "../../lib/sslcommerz.js";
import {
  createFakeGateway,
  createTutorFeeFixture,
  fakeSuccess,
  setPlatformSetting,
} from "../../tests/helpers.js";
import { newTranId } from "../fees/fee-quote.js";
import { reconcileAttempt } from "./payment.service.js";
import { runPaymentReconcile } from "./payment-reconcile.service.js";

const MINUTE = 60_000;

const savedEnv = {
  SSLC_STORE_ID: env.SSLC_STORE_ID,
  SSLC_STORE_PASSWORD: env.SSLC_STORE_PASSWORD,
  API_PUBLIC_URL: env.API_PUBLIC_URL,
  WEB_PUBLIC_URL: env.WEB_PUBLIC_URL,
};

// One PENDING attempt on its own fee (a fee can hold only one PENDING attempt), created `ageMs` ago.
async function pendingAttempt(ageMs: number, lastCheckedAt: Date | null = null) {
  const setup = await createTutorFeeFixture(1500);
  return prisma.paymentAttempt.create({
    data: {
      feeId: setup.fee.id,
      tutorId: setup.tutor.id,
      tranId: newTranId(),
      feeAmount: "1500.00",
      chargeAmount: "37.50",
      totalAmount: "1537.50",
      createdAt: new Date(Date.now() - ageMs),
      lastCheckedAt,
    },
  });
}

// Wraps the fake gateway to record which tran_ids are queried. failOn fails calls with a
// GatewayError; plainErrorOn fails the queries of chosen tran_ids with a non-gateway Error.
function gatewayWith(
  base: PaymentGateway,
  failOn: (call: number) => boolean = () => false,
  plainErrorOn: (tranId: string) => boolean = () => false,
) {
  const queried: string[] = [];
  const gateway: PaymentGateway = {
    ...base,
    async queryByTranId(tranId) {
      const call = queried.push(tranId) - 1;
      if (failOn(call)) throw new GatewayError("unavailable", "Fake gateway down");
      if (plainErrorOn(tranId)) throw new Error("boom");
      return base.queryByTranId(tranId);
    },
  };
  return { gateway, queried };
}

// A query element with the given gateway status and no val_id (nothing was paid).
function endedRecord(tranId: string, status: string): GatewayTransaction {
  return {
    status,
    tranId,
    valId: null,
    amount: "1537.50",
    currencyType: "BDT",
    currencyAmount: "1537.50",
    bankTranId: null,
    cardType: null,
    riskLevel: null,
    riskTitle: null,
    raw: {},
  };
}

describe("runPaymentReconcile", () => {
  let fake: ReturnType<typeof createFakeGateway>;

  beforeEach(async () => {
    fake = createFakeGateway();
    setPaymentGatewayForTests(fake.gateway);
    env.SSLC_STORE_ID = "store_test";
    env.SSLC_STORE_PASSWORD = "pw_test_secret";
    env.API_PUBLIC_URL = "http://api.test";
    env.WEB_PUBLIC_URL = "http://web.test";
    await setPlatformSetting("online_payments_enabled", true);
  });

  afterEach(() => {
    setPaymentGatewayForTests(null);
    Object.assign(env, savedEnv);
  });

  it("skips the run when payments are not configured", async () => {
    env.SSLC_STORE_ID = undefined;
    const attempt = await pendingAttempt(10 * MINUTE);
    const { gateway, queried } = gatewayWith(fake.gateway);
    setPaymentGatewayForTests(gateway);

    const result = await runPaymentReconcile();

    expect(result).toMatchObject({ skipped: true, checked: 0, aborted: false });
    expect(queried).toHaveLength(0);
    const after = await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(after.status).toBe("PENDING");
    expect(after.lastCheckedAt).toBeNull();
  });

  it("leaves an attempt younger than 2 minutes alone", async () => {
    const attempt = await pendingAttempt(30 * 1000);
    const { gateway, queried } = gatewayWith(fake.gateway);
    setPaymentGatewayForTests(gateway);

    const result = await runPaymentReconcile();

    expect(result).toMatchObject({ skipped: false, checked: 0 });
    expect(queried).toHaveLength(0);
    const after = await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(after.lastCheckedAt).toBeNull();
  });

  it("leaves an attempt checked in the last 5 minutes alone", async () => {
    const checkedAt = new Date(Date.now() - 2 * MINUTE);
    const attempt = await pendingAttempt(10 * MINUTE, checkedAt);
    const { gateway, queried } = gatewayWith(fake.gateway);
    setPaymentGatewayForTests(gateway);

    const result = await runPaymentReconcile();

    expect(result.checked).toBe(0);
    expect(queried).toHaveLength(0);
    const after = await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(after.lastCheckedAt?.getTime()).toBe(checkedAt.getTime());
  });

  it("settles a stale attempt the gateway reports as paid, with one ledger row", async () => {
    const attempt = await pendingAttempt(10 * MINUTE);
    const tx = fakeSuccess({ tranId: attempt.tranId, valId: "VAL-REC-1", amount: "1537.50" });
    fake.setQuery(attempt.tranId, [tx]);
    fake.setValidation("VAL-REC-1", tx);

    const result = await runPaymentReconcile();

    expect(result).toMatchObject({ checked: 1, settled: 1, stillPending: 0, gatewayErrors: 0 });
    const after = await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(after.status).toBe("SUCCEEDED");
    expect(after.paymentId).not.toBeNull();
    const payments = await prisma.feePayment.findMany({ where: { feeId: attempt.feeId } });
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({
      method: "SSLCOMMERZ",
      txnReference: attempt.tranId,
      kind: "PAYMENT",
    });
    expect(payments[0].amount.toFixed(2)).toBe("1500.00");
  });

  it("marks a stale attempt FAILED when the gateway reports it failed", async () => {
    const attempt = await pendingAttempt(10 * MINUTE);
    fake.setQuery(attempt.tranId, [endedRecord(attempt.tranId, "FAILED")]);

    const result = await runPaymentReconcile();

    expect(result).toMatchObject({ checked: 1, ended: 1 });
    const after = await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(after.status).toBe("FAILED");
    expect(after.failureReason).toBe("Gateway status FAILED");
  });

  it("expires an attempt the gateway never heard of after 60 minutes", async () => {
    const attempt = await pendingAttempt(61 * MINUTE);

    const result = await runPaymentReconcile();

    expect(result).toMatchObject({ checked: 1, ended: 1, stillPending: 0 });
    const after = await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(after.status).toBe("EXPIRED");
    expect(after.failureReason).toBe("No completed payment at the gateway after 60 minutes");
  });

  it("keeps an unknown attempt PENDING while it is younger than 60 minutes", async () => {
    const attempt = await pendingAttempt(10 * MINUTE);

    const result = await runPaymentReconcile();

    expect(result).toMatchObject({ checked: 1, stillPending: 1, ended: 0 });
    const after = await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(after.status).toBe("PENDING");
    expect(after.lastCheckedAt).not.toBeNull();
  });

  it.each(["PROCESSING", "PENDING", "INITIATED"])(
    "keeps an attempt the gateway reports as %s PENDING while it is younger than 60 minutes",
    async (status) => {
      const attempt = await pendingAttempt(10 * MINUTE);
      fake.setQuery(attempt.tranId, [endedRecord(attempt.tranId, status)]);

      const result = await runPaymentReconcile();

      expect(result).toMatchObject({ checked: 1, stillPending: 1, ended: 0, settled: 0 });
      const after = await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
      expect(after.status).toBe("PENDING");
      expect(after.failureReason).toBeNull();
      expect(after.lastCheckedAt).not.toBeNull();
    },
  );

  it("expires an attempt the gateway reports as PROCESSING once it is older than 60 minutes", async () => {
    const attempt = await pendingAttempt(61 * MINUTE);
    fake.setQuery(attempt.tranId, [endedRecord(attempt.tranId, "PROCESSING")]);

    const result = await runPaymentReconcile();

    expect(result).toMatchObject({ checked: 1, ended: 1, stillPending: 0 });
    const after = await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(after.status).toBe("EXPIRED");
    expect(after.failureReason).toBe("No completed payment at the gateway after 60 minutes");
  });

  it("expires an attempt the gateway reports as UNATTEMPTED at once, even when it is young", async () => {
    const attempt = await pendingAttempt(10 * MINUTE);
    fake.setQuery(attempt.tranId, [endedRecord(attempt.tranId, "UNATTEMPTED")]);

    const result = await runPaymentReconcile();

    expect(result).toMatchObject({ checked: 1, ended: 1, stillPending: 0 });
    const after = await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(after.status).toBe("EXPIRED");
    expect(after.failureReason).toBe("Gateway status UNATTEMPTED");
  });

  it("expires an attempt the gateway reports as EXPIRED at once, even when it is young", async () => {
    const attempt = await pendingAttempt(10 * MINUTE);
    fake.setQuery(attempt.tranId, [endedRecord(attempt.tranId, "EXPIRED")]);

    const result = await runPaymentReconcile();

    expect(result).toMatchObject({ checked: 1, ended: 1, stillPending: 0 });
    const after = await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(after.status).toBe("EXPIRED");
    expect(after.failureReason).toBe("Gateway status EXPIRED");
  });

  it("settles a late verified success on an attempt the gateway had expired", async () => {
    const attempt = await pendingAttempt(10 * MINUTE);
    fake.setQuery(attempt.tranId, [endedRecord(attempt.tranId, "UNATTEMPTED")]);
    await runPaymentReconcile();
    const expired = await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(expired.status).toBe("EXPIRED");

    const tx = fakeSuccess({ tranId: attempt.tranId, valId: "VAL-LATE", amount: "1537.50" });
    fake.setQuery(attempt.tranId, [tx]);
    fake.setValidation("VAL-LATE", tx);
    await reconcileAttempt(attempt.tranId);

    const after = await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(after.status).toBe("SUCCEEDED");
    const payments = await prisma.feePayment.findMany({ where: { feeId: attempt.feeId } });
    expect(payments).toHaveLength(1);
  });

  it("stops after three gateway errors in a row and leaves the rest untouched", async () => {
    const attempts = [
      await pendingAttempt(13 * MINUTE),
      await pendingAttempt(12 * MINUTE),
      await pendingAttempt(11 * MINUTE),
      await pendingAttempt(10 * MINUTE),
    ];
    const { gateway, queried } = gatewayWith(fake.gateway, () => true);
    setPaymentGatewayForTests(gateway);

    const result = await runPaymentReconcile();

    expect(result).toMatchObject({ checked: 3, gatewayErrors: 3, aborted: true });
    expect(queried).toEqual(attempts.slice(0, 3).map((a) => a.tranId));
    const fourth = await prisma.paymentAttempt.findUniqueOrThrow({
      where: { id: attempts[3].id },
    });
    expect(fourth.status).toBe("PENDING");
    expect(fourth.lastCheckedAt).toBeNull();
  });

  it("does not stop when a successful call breaks up the gateway errors", async () => {
    const attempts = [
      await pendingAttempt(13 * MINUTE),
      await pendingAttempt(12 * MINUTE),
      await pendingAttempt(11 * MINUTE),
      await pendingAttempt(10 * MINUTE),
    ];
    // Calls 0, 2 and 3 fail; call 1 gets an answer (nothing found, so it stays PENDING).
    const { gateway } = gatewayWith(fake.gateway, (call) => call !== 1);
    setPaymentGatewayForTests(gateway);

    const result = await runPaymentReconcile();

    expect(result).toMatchObject({
      checked: 4,
      gatewayErrors: 3,
      stillPending: 1,
      aborted: false,
    });
    const second = await prisma.paymentAttempt.findUniqueOrThrow({
      where: { id: attempts[1].id },
    });
    expect(second.lastCheckedAt).not.toBeNull();
  });

  it("records a non-gateway error on one attempt and still settles the next", async () => {
    const broken = await pendingAttempt(12 * MINUTE);
    const good = await pendingAttempt(11 * MINUTE);
    const tx = fakeSuccess({ tranId: good.tranId, valId: "VAL-REC-BOOM", amount: "1537.50" });
    fake.setQuery(good.tranId, [tx]);
    fake.setValidation("VAL-REC-BOOM", tx);
    const { gateway } = gatewayWith(
      fake.gateway,
      () => false,
      (tranId) => tranId === broken.tranId,
    );
    setPaymentGatewayForTests(gateway);
    const logs: string[] = [];

    const result = await runPaymentReconcile({ log: (msg) => logs.push(msg) });

    expect(result).toMatchObject({
      checked: 2,
      failed: 1,
      settled: 1,
      gatewayErrors: 0,
      aborted: false,
    });
    expect(logs).toEqual([`payment-reconcile: error on ${broken.tranId}: boom`]);
    const first = await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: broken.id } });
    expect(first.status).toBe("PENDING");
    const second = await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: good.id } });
    expect(second.status).toBe("SUCCEEDED");
  });

  it("takes the oldest attempts first and stops at the limit", async () => {
    const oldest = await pendingAttempt(12 * MINUTE);
    const middle = await pendingAttempt(11 * MINUTE);
    const newest = await pendingAttempt(10 * MINUTE);
    const { gateway, queried } = gatewayWith(fake.gateway);
    setPaymentGatewayForTests(gateway);

    const result = await runPaymentReconcile({ limit: 2 });

    expect(result.checked).toBe(2);
    expect(queried).toEqual([oldest.tranId, middle.tranId]);
    const untouched = await prisma.paymentAttempt.findUniqueOrThrow({
      where: { id: newest.id },
    });
    expect(untouched.lastCheckedAt).toBeNull();
  });

  it("settles payments while online payments are switched off", async () => {
    await setPlatformSetting("online_payments_enabled", false);
    const attempt = await pendingAttempt(10 * MINUTE);
    const tx = fakeSuccess({ tranId: attempt.tranId, valId: "VAL-REC-OFF", amount: "1537.50" });
    fake.setQuery(attempt.tranId, [tx]);
    fake.setValidation("VAL-REC-OFF", tx);

    const result = await runPaymentReconcile();

    expect(result).toMatchObject({ skipped: false, settled: 1 });
    const after = await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(after.status).toBe("SUCCEEDED");
  });
});
