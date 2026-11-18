import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import { type GatewayTransaction, setPaymentGatewayForTests } from "../../lib/sslcommerz.js";
import {
  createFakeGateway,
  createFeePayment,
  createSuperAdmin,
  createTestApp,
  createTutorFeeFixture,
  fakeSuccess,
  getAuthHeaders,
  setPlatformSetting,
} from "../../tests/helpers.js";
import { settleAttempt } from "./payment.service.js";

const CALLBACKS = "/api/v1/payments/sslcommerz";
const WEB = "http://web.test";

type App = Awaited<ReturnType<typeof createTestApp>>;

// Starts a checkout through the API and returns its tran_id (the fee total is 1537.50 at 2.5%).
async function startCheckout(
  app: App,
  setup: { tutorAccount: Parameters<typeof getAuthHeaders>[0]; fee: { id: string } },
) {
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/fees/${setup.fee.id}/checkout`,
    headers: await getAuthHeaders(setup.tutorAccount),
  });
  expect(res.statusCode).toBe(201);
  return JSON.parse(res.body) as { tranId: string; totalAmount: string };
}

// The browser and SSLCommerz post form-encoded bodies.
async function post(app: App, path: string, fields: Record<string, string>) {
  return app.inject({
    method: "POST",
    url: `${CALLBACKS}/${path}`,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams(fields).toString(),
  });
}

async function ledgerRowsFor(feeId: string) {
  return prisma.feePayment.findMany({ where: { feeId } });
}

const savedEnv = {
  SSLC_STORE_ID: env.SSLC_STORE_ID,
  SSLC_STORE_PASSWORD: env.SSLC_STORE_PASSWORD,
  API_PUBLIC_URL: env.API_PUBLIC_URL,
  WEB_PUBLIC_URL: env.WEB_PUBLIC_URL,
};

describe("SSLCommerz callbacks", () => {
  let fake: ReturnType<typeof createFakeGateway>;

  beforeEach(async () => {
    fake = createFakeGateway();
    setPaymentGatewayForTests(fake.gateway);
    env.SSLC_STORE_ID = "store_test";
    env.SSLC_STORE_PASSWORD = "pw_test_secret";
    env.API_PUBLIC_URL = "http://api.test";
    env.WEB_PUBLIC_URL = WEB;
    await setPlatformSetting("online_payments_enabled", true);
    await setPlatformSetting("gateway_charge_percent", 2.5);
  });

  afterEach(() => {
    setPaymentGatewayForTests(null);
    Object.assign(env, savedEnv);
  });

  describe("success", () => {
    it("settles a verified success once and redirects to the payment page", async () => {
      const app = await createTestApp();
      const setup = await createTutorFeeFixture(1500);
      const { tranId, totalAmount } = await startCheckout(app, setup);
      fake.setValidation("VAL-1", fakeSuccess({ tranId, valId: "VAL-1", amount: totalAmount }));

      const res = await post(app, "success", { tran_id: tranId, val_id: "VAL-1", status: "VALID" });

      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe(
        `${WEB}/dashboard/fees/${setup.fee.id}/payment?tran=${tranId}`,
      );

      const fee = await prisma.platformFee.findUniqueOrThrow({ where: { id: setup.fee.id } });
      expect(fee.status).toBe("PAID");
      expect(fee.amountPaid.toFixed(2)).toBe("1500.00");

      const ledger = await ledgerRowsFor(setup.fee.id);
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({
        method: "SSLCOMMERZ",
        kind: "PAYMENT",
        recordedById: null,
        txnReference: tranId,
      });
      expect(ledger[0].amount.toFixed(2)).toBe("1500.00");

      const attempt = await prisma.paymentAttempt.findUniqueOrThrow({ where: { tranId } });
      expect(attempt.status).toBe("SUCCEEDED");
      expect(attempt.paymentId).toBe(ledger[0].id);
      expect(attempt.bankTranId).toBe("BANK-VAL-1");
      expect(attempt.settledAt).not.toBeNull();
    });

    it("keeps one ledger row when the IPN repeats the same success", async () => {
      const app = await createTestApp();
      const setup = await createTutorFeeFixture(1500);
      const { tranId, totalAmount } = await startCheckout(app, setup);
      fake.setValidation("VAL-2", fakeSuccess({ tranId, valId: "VAL-2", amount: totalAmount }));

      await post(app, "success", { tran_id: tranId, val_id: "VAL-2", status: "VALID" });
      const ipn = await post(app, "ipn", { tran_id: tranId, val_id: "VAL-2", status: "VALID" });

      expect(ipn.statusCode).toBe(200);
      expect(JSON.parse(ipn.body)).toEqual({ received: true });
      expect(await ledgerRowsFor(setup.fee.id)).toHaveLength(1);
    });

    it("keeps one ledger row when two settles of the same success run together", async () => {
      const app = await createTestApp();
      const setup = await createTutorFeeFixture(1500);
      const { tranId, totalAmount } = await startCheckout(app, setup);
      fake.setValidation("VAL-3", fakeSuccess({ tranId, valId: "VAL-3", amount: totalAmount }));

      const results = await Promise.all([
        settleAttempt(tranId, "VAL-3"),
        settleAttempt(tranId, "VAL-3"),
      ]);

      expect(results.every((r) => r?.status === "SUCCEEDED")).toBe(true);
      expect(await ledgerRowsFor(setup.fee.id)).toHaveLength(1);
    });

    it("answers 303 to the fees list for an unknown tran_id", async () => {
      const app = await createTestApp();

      const res = await post(app, "success", {
        tran_id: "TMNOTREAL1",
        val_id: "VAL-X",
        status: "VALID",
      });

      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe(`${WEB}/dashboard/fees`);
    });

    it("answers 303 to the fees list for a body without tran_id", async () => {
      const app = await createTestApp();

      const res = await post(app, "success", { val_id: "VAL-X", status: "VALID" });

      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe(`${WEB}/dashboard/fees`);
    });

    it("redirects to / when WEB_PUBLIC_URL is not set", async () => {
      env.WEB_PUBLIC_URL = undefined;
      const app = await createTestApp();

      const res = await post(app, "success", { tran_id: "TMNOTREAL1", val_id: "VAL-X" });

      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe("/");
    });

    it("still redirects when the gateway is down, and leaves the attempt PENDING", async () => {
      const app = await createTestApp();
      const setup = await createTutorFeeFixture(1500);
      const { tranId } = await startCheckout(app, setup);
      fake.failNext("unavailable");

      const res = await post(app, "success", {
        tran_id: tranId,
        val_id: "VAL-DOWN",
        status: "VALID",
      });

      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe(
        `${WEB}/dashboard/fees/${setup.fee.id}/payment?tran=${tranId}`,
      );
      const attempt = await prisma.paymentAttempt.findUniqueOrThrow({ where: { tranId } });
      expect(attempt.status).toBe("PENDING");
      expect(await ledgerRowsFor(setup.fee.id)).toHaveLength(0);
    });

    it("reconciles when the redirect has no val_id", async () => {
      const app = await createTestApp();
      const setup = await createTutorFeeFixture(1500);
      const { tranId, totalAmount } = await startCheckout(app, setup);
      const paid = fakeSuccess({ tranId, valId: "VAL-REC", amount: totalAmount });
      fake.setQuery(tranId, [paid]);
      fake.setValidation("VAL-REC", paid);

      const res = await post(app, "success", { tran_id: tranId });

      expect(res.statusCode).toBe(303);
      const attempt = await prisma.paymentAttempt.findUniqueOrThrow({ where: { tranId } });
      expect(attempt.status).toBe("SUCCEEDED");
      expect(await ledgerRowsFor(setup.fee.id)).toHaveLength(1);
    });
  });

  describe("REVIEW: the gateway says paid, but something is off", () => {
    it.each([
      [
        "the amount differs",
        (t: string, v: string) => fakeSuccess({ tranId: t, valId: v, amount: "1500.00" }),
      ],
      [
        "the currency is USD",
        (t: string, v: string) => ({
          ...fakeSuccess({ tranId: t, valId: v, amount: "1537.50" }),
          currencyType: "USD",
        }),
      ],
      [
        "the risk level is 1",
        (t: string, v: string) => ({
          ...fakeSuccess({ tranId: t, valId: v, amount: "1537.50" }),
          riskLevel: 1,
        }),
      ],
    ])("sends the attempt to REVIEW when %s", async (_label, build) => {
      const app = await createTestApp();
      const setup = await createTutorFeeFixture(1500);
      const { tranId } = await startCheckout(app, setup);
      const tx: GatewayTransaction = build(tranId, "VAL-REVIEW");
      fake.setValidation("VAL-REVIEW", tx);

      const res = await post(app, "success", {
        tran_id: tranId,
        val_id: "VAL-REVIEW",
        status: "VALID",
      });

      expect(res.statusCode).toBe(303);
      const attempt = await prisma.paymentAttempt.findUniqueOrThrow({ where: { tranId } });
      expect(attempt.status).toBe("REVIEW");
      expect(attempt.failureReason).toBeTruthy();
      expect(attempt.valId).toBe("VAL-REVIEW");
      expect(attempt.paymentId).toBeNull();
      expect(await ledgerRowsFor(setup.fee.id)).toHaveLength(0);
      const fee = await prisma.platformFee.findUniqueOrThrow({ where: { id: setup.fee.id } });
      expect(fee.status).toBe("DUE");
    });
  });

  describe("UNAPPLIED: the gateway took the money but the ledger refuses it", () => {
    it("marks the attempt UNAPPLIED when the fee was waived after checkout", async () => {
      const app = await createTestApp();
      const setup = await createTutorFeeFixture(1500);
      const { tranId, totalAmount } = await startCheckout(app, setup);
      await prisma.platformFee.update({ where: { id: setup.fee.id }, data: { status: "WAIVED" } });
      fake.setValidation("VAL-W", fakeSuccess({ tranId, valId: "VAL-W", amount: totalAmount }));

      const res = await post(app, "success", { tran_id: tranId, val_id: "VAL-W", status: "VALID" });

      expect(res.statusCode).toBe(303);
      const attempt = await prisma.paymentAttempt.findUniqueOrThrow({ where: { tranId } });
      expect(attempt.status).toBe("UNAPPLIED");
      expect(attempt.failureReason).toContain("WAIVED");
      expect(attempt.paymentId).toBeNull();
      expect(await ledgerRowsFor(setup.fee.id)).toHaveLength(0);
    });

    it("marks the attempt UNAPPLIED on an overpay and leaves the fee PARTIAL", async () => {
      const app = await createTestApp();
      const setup = await createTutorFeeFixture(1500);
      const { tranId, totalAmount } = await startCheckout(app, setup);
      const admin = await createSuperAdmin();
      await createFeePayment({ feeId: setup.fee.id, amount: 1000, recordedById: admin.id });
      fake.setValidation("VAL-O", fakeSuccess({ tranId, valId: "VAL-O", amount: totalAmount }));

      const res = await post(app, "success", { tran_id: tranId, val_id: "VAL-O", status: "VALID" });

      expect(res.statusCode).toBe(303);
      const attempt = await prisma.paymentAttempt.findUniqueOrThrow({ where: { tranId } });
      expect(attempt.status).toBe("UNAPPLIED");
      const fee = await prisma.platformFee.findUniqueOrThrow({ where: { id: setup.fee.id } });
      expect(fee.status).toBe("PARTIAL");
      expect(fee.amountPaid.toFixed(2)).toBe("1000.00");
      expect(await ledgerRowsFor(setup.fee.id)).toHaveLength(1);
    });
  });

  describe("val_id that does not belong to this transaction", () => {
    it("leaves the attempt untouched when validate ties the val_id to another tran_id, then settles on the real val_id", async () => {
      const app = await createTestApp();
      const setup = await createTutorFeeFixture(1500);
      const { tranId, totalAmount } = await startCheckout(app, setup);
      // An attacker's own genuine payment: its val_id validates to a different tran_id.
      fake.setValidation(
        "VAL-ATTACKER",
        fakeSuccess({ tranId: "OTHERTRAN1", valId: "VAL-ATTACKER", amount: totalAmount }),
      );

      const foreign = await post(app, "success", {
        tran_id: tranId,
        val_id: "VAL-ATTACKER",
        status: "VALID",
      });

      expect(foreign.statusCode).toBe(303);
      const untouched = await prisma.paymentAttempt.findUniqueOrThrow({ where: { tranId } });
      expect(untouched.status).toBe("PENDING");
      expect(untouched.valId).toBeNull();
      expect(untouched.failureReason).toBeNull();
      expect(await ledgerRowsFor(setup.fee.id)).toHaveLength(0);

      fake.setValidation(
        "VAL-REAL",
        fakeSuccess({ tranId, valId: "VAL-REAL", amount: totalAmount }),
      );
      await post(app, "success", { tran_id: tranId, val_id: "VAL-REAL", status: "VALID" });

      const settled = await prisma.paymentAttempt.findUniqueOrThrow({ where: { tranId } });
      expect(settled.status).toBe("SUCCEEDED");
      expect(await ledgerRowsFor(setup.fee.id)).toHaveLength(1);
    });

    it("leaves a PENDING attempt alone when validate answers with an empty tran_id, and still redirects", async () => {
      const app = await createTestApp();
      const setup = await createTutorFeeFixture(1500);
      const { tranId } = await startCheckout(app, setup);
      // No validation registered: the fake answers INVALID_TRANSACTION with an empty tran_id.

      const res = await post(app, "success", {
        tran_id: tranId,
        val_id: "VAL-BOGUS",
        status: "VALID",
      });

      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe(
        `${WEB}/dashboard/fees/${setup.fee.id}/payment?tran=${tranId}`,
      );
      const attempt = await prisma.paymentAttempt.findUniqueOrThrow({ where: { tranId } });
      expect(attempt.status).toBe("PENDING");
      expect(attempt.failureReason).toBeNull();
    });

    it.each(["INVALID_TRANSACTION", "FAILED"])(
      "marks the attempt FAILED when the gateway confirms this tran_id with status %s",
      async (status) => {
        const app = await createTestApp();
        const setup = await createTutorFeeFixture(1500);
        const { tranId, totalAmount } = await startCheckout(app, setup);
        fake.setValidation("VAL-NONE", {
          ...fakeSuccess({ tranId, valId: "VAL-NONE", amount: totalAmount }),
          status,
        });

        const res = await post(app, "success", {
          tran_id: tranId,
          val_id: "VAL-NONE",
          status: "VALID",
        });

        expect(res.statusCode).toBe(303);
        const attempt = await prisma.paymentAttempt.findUniqueOrThrow({ where: { tranId } });
        expect(attempt.status).toBe("FAILED");
        expect(attempt.failureReason).toBe(`Gateway status ${status}`);
      },
    );
  });

  describe("fail, cancel and IPN", () => {
    it("marks the attempt FAILED with the gateway error, then a verified IPN success wins", async () => {
      const app = await createTestApp();
      const setup = await createTutorFeeFixture(1500);
      const { tranId, totalAmount } = await startCheckout(app, setup);

      const failed = await post(app, "fail", { tran_id: tranId, error: "Card declined" });

      expect(failed.statusCode).toBe(303);
      expect(failed.headers.location).toBe(
        `${WEB}/dashboard/fees/${setup.fee.id}/payment?tran=${tranId}`,
      );
      const afterFail = await prisma.paymentAttempt.findUniqueOrThrow({ where: { tranId } });
      expect(afterFail.status).toBe("FAILED");
      expect(afterFail.failureReason).toBe("Card declined");

      fake.setValidation(
        "VAL-LATE",
        fakeSuccess({ tranId, valId: "VAL-LATE", amount: totalAmount }),
      );
      const ipn = await post(app, "ipn", { tran_id: tranId, val_id: "VAL-LATE", status: "VALID" });

      expect(ipn.statusCode).toBe(200);
      const settled = await prisma.paymentAttempt.findUniqueOrThrow({ where: { tranId } });
      expect(settled.status).toBe("SUCCEEDED");
      expect(await ledgerRowsFor(setup.fee.id)).toHaveLength(1);
    });

    it("marks the attempt CANCELLED with the default reason, and a later success still settles it", async () => {
      const app = await createTestApp();
      const setup = await createTutorFeeFixture(1500);
      const { tranId, totalAmount } = await startCheckout(app, setup);

      const res = await post(app, "cancel", { tran_id: tranId });

      expect(res.statusCode).toBe(303);
      const cancelled = await prisma.paymentAttempt.findUniqueOrThrow({ where: { tranId } });
      expect(cancelled.status).toBe("CANCELLED");
      expect(cancelled.failureReason).toBe("Payment cancelled");

      fake.setValidation("VAL-C", fakeSuccess({ tranId, valId: "VAL-C", amount: totalAmount }));
      await post(app, "success", { tran_id: tranId, val_id: "VAL-C", status: "VALID" });

      const settled = await prisma.paymentAttempt.findUniqueOrThrow({ where: { tranId } });
      expect(settled.status).toBe("SUCCEEDED");
    });

    it("answers 200 to an IPN for an unknown tran_id", async () => {
      const app = await createTestApp();

      const res = await post(app, "ipn", {
        tran_id: "TMNOTREAL1",
        val_id: "VAL-X",
        status: "VALID",
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ received: true });
    });

    it("answers 200 to an IPN without tran_id", async () => {
      const app = await createTestApp();

      const res = await post(app, "ipn", { status: "VALID" });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ received: true });
    });

    it("answers 200 and leaves the attempt PENDING when the IPN cannot reach the gateway", async () => {
      const app = await createTestApp();
      const setup = await createTutorFeeFixture(1500);
      const { tranId } = await startCheckout(app, setup);
      fake.failNext("unavailable");

      const res = await post(app, "ipn", { tran_id: tranId, val_id: "VAL-IPN", status: "VALID" });

      expect(res.statusCode).toBe(200);
      const attempt = await prisma.paymentAttempt.findUniqueOrThrow({ where: { tranId } });
      expect(attempt.status).toBe("PENDING");
    });

    it("answers 303 to the fees list for a fail callback with an unknown tran_id", async () => {
      const app = await createTestApp();

      const res = await post(app, "cancel", { tran_id: "TMNOTREAL1" });

      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe(`${WEB}/dashboard/fees`);
    });
  });
});
