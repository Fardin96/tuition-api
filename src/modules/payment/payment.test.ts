import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import { type GatewayTransaction, setPaymentGatewayForTests } from "../../lib/sslcommerz.js";
import {
  createAccount,
  createFakeGateway,
  createFeePayment,
  createPlatformFee,
  createSuperAdmin,
  createTestApp,
  createTutorFeeFixture,
  createTutorProfile,
  fakeSuccess,
  getAuthHeaders,
  setPlatformSetting,
} from "../../tests/helpers.js";
import { isPendingConflict, settleAttempt, startCheckout } from "./payment.service.js";

const PENDING_INDEX = "payment_attempt_one_pending_per_fee";

async function checkout(
  app: Awaited<ReturnType<typeof createTestApp>>,
  headers: Record<string, string>,
  feeId: string,
) {
  return app.inject({
    method: "POST",
    url: `/api/v1/fees/${feeId}/checkout`,
    headers,
  });
}

function attemptUrl(feeId: string, tranId: string) {
  return `/api/v1/fees/${feeId}/attempts/${tranId}`;
}

// A gateway query element with the given status and no val_id (nothing was paid).
function gatewayRecord(tranId: string, status: string): GatewayTransaction {
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

const savedEnv = {
  SSLC_STORE_ID: env.SSLC_STORE_ID,
  SSLC_STORE_PASSWORD: env.SSLC_STORE_PASSWORD,
  API_PUBLIC_URL: env.API_PUBLIC_URL,
  WEB_PUBLIC_URL: env.WEB_PUBLIC_URL,
};

describe("payment checkout", () => {
  let fake: ReturnType<typeof createFakeGateway>;

  beforeEach(async () => {
    fake = createFakeGateway();
    setPaymentGatewayForTests(fake.gateway);
    env.SSLC_STORE_ID = "store_test";
    env.SSLC_STORE_PASSWORD = "pw_test_secret";
    env.API_PUBLIC_URL = "http://api.test";
    env.WEB_PUBLIC_URL = "http://web.test";
    await setPlatformSetting("online_payments_enabled", true);
    await setPlatformSetting("gateway_charge_percent", 2.5);
  });

  afterEach(() => {
    setPaymentGatewayForTests(null);
    Object.assign(env, savedEnv);
  });

  describe("POST /api/v1/fees/:id/checkout", () => {
    it("returns 503 PAYMENTS_DISABLED when the kill switch is off", async () => {
      await setPlatformSetting("online_payments_enabled", false);
      const app = await createTestApp();
      const setup = await createTutorFeeFixture();

      const res = await checkout(app, await getAuthHeaders(setup.tutorAccount), setup.fee.id);

      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body).code).toBe("PAYMENTS_DISABLED");
      expect(fake.sessions).toHaveLength(0);
    });

    it("returns 503 PAYMENTS_DISABLED when API_PUBLIC_URL is not set", async () => {
      env.API_PUBLIC_URL = undefined;
      const app = await createTestApp();
      const setup = await createTutorFeeFixture();

      const res = await checkout(app, await getAuthHeaders(setup.tutorAccount), setup.fee.id);

      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body).code).toBe("PAYMENTS_DISABLED");
      expect(fake.sessions).toHaveLength(0);
    });

    it("quotes the fee plus the gateway charge and stores a PENDING attempt", async () => {
      const app = await createTestApp();
      const setup = await createTutorFeeFixture(1500);

      const res = await checkout(app, await getAuthHeaders(setup.tutorAccount), setup.fee.id);

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body).toMatchObject({
        feeAmount: "1500.00",
        chargeAmount: "37.50",
        totalAmount: "1537.50",
      });
      expect(body.tranId).toMatch(/^[A-Za-z0-9]{1,30}$/);
      expect(res.headers["cache-control"]).toBe("private, no-store");

      const attempt = await prisma.paymentAttempt.findUniqueOrThrow({
        where: { tranId: body.tranId },
      });
      expect(attempt.status).toBe("PENDING");
      expect(attempt.feeId).toBe(setup.fee.id);
      expect(attempt.sessionKey).toBe(`SK-${body.tranId}`);
      expect(attempt.totalAmount.toFixed(2)).toBe("1537.50");
      expect(body.gatewayUrl).toContain(body.tranId);

      expect(fake.sessions).toHaveLength(1);
      const session = fake.sessions[0];
      expect(session.tranId).toBe(body.tranId);
      expect(session.totalAmount).toBe("1537.50");
      expect(session.valueA).toBe(setup.fee.id);
      expect(session.productName).toBe("Placement fee");
      expect(session.customer).toEqual({
        name: setup.tutor.name,
        email: setup.tutorAccount.email,
        phone: setup.tutor.phoneNumber,
        city: "Dhaka",
      });
      expect(session.urls).toEqual({
        success: "http://api.test/api/v1/payments/sslcommerz/success",
        fail: "http://api.test/api/v1/payments/sslcommerz/fail",
        cancel: "http://api.test/api/v1/payments/sslcommerz/cancel",
        ipn: "http://api.test/api/v1/payments/sslcommerz/ipn",
      });
    });

    it("returns 404 for a fee of another tutor", async () => {
      const app = await createTestApp();
      const setup = await createTutorFeeFixture();
      const other = await createAccount({ role: "TUTOR" });
      await createTutorProfile(other.id);

      const res = await checkout(app, await getAuthHeaders(other), setup.fee.id);

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).message).toBe("Fee not found");
      expect(fake.sessions).toHaveLength(0);
    });

    it("returns 403 for a student", async () => {
      const app = await createTestApp();
      const setup = await createTutorFeeFixture();

      const res = await checkout(app, await getAuthHeaders(setup.studentAccount), setup.fee.id);

      expect(res.statusCode).toBe(403);
    });

    it("returns 401 without a token", async () => {
      const app = await createTestApp();
      const setup = await createTutorFeeFixture();

      const res = await checkout(app, {}, setup.fee.id);

      expect(res.statusCode).toBe(401);
    });

    it("refuses a fee that is already PAID", async () => {
      const app = await createTestApp();
      const setup = await createTutorFeeFixture(1500);
      const admin = await createSuperAdmin();
      await createFeePayment({ feeId: setup.fee.id, amount: 1500, recordedById: admin.id });

      const res = await checkout(app, await getAuthHeaders(setup.tutorAccount), setup.fee.id);

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).code).toBe("INVALID_FEE_STATE");
      expect(fake.sessions).toHaveLength(0);
    });

    it("refuses a WAIVED fee", async () => {
      const app = await createTestApp();
      const setup = await createTutorFeeFixture();
      await prisma.platformFee.update({ where: { id: setup.fee.id }, data: { status: "WAIVED" } });

      const res = await checkout(app, await getAuthHeaders(setup.tutorAccount), setup.fee.id);

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).code).toBe("INVALID_FEE_STATE");
    });

    it("refuses a VOID fee", async () => {
      const app = await createTestApp();
      const setup = await createTutorFeeFixture();
      await prisma.platformFee.update({ where: { id: setup.fee.id }, data: { status: "VOID" } });

      const res = await checkout(app, await getAuthHeaders(setup.tutorAccount), setup.fee.id);

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).code).toBe("INVALID_FEE_STATE");
    });

    it("refuses a remaining 5.00 with no charge, below the 10 taka minimum", async () => {
      await setPlatformSetting("gateway_charge_percent", 0);
      const app = await createTestApp();
      const setup = await createTutorFeeFixture(5);

      const res = await checkout(app, await getAuthHeaders(setup.tutorAccount), setup.fee.id);

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).message).toContain("Online payments start at");
      expect(fake.sessions).toHaveLength(0);
    });

    it("marks the attempt FAILED and returns 503 when the gateway rejects the session", async () => {
      const app = await createTestApp();
      const setup = await createTutorFeeFixture();
      fake.failNext("rejected");

      const res = await checkout(app, await getAuthHeaders(setup.tutorAccount), setup.fee.id);

      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body).code).toBe("GATEWAY_UNAVAILABLE");
      const attempts = await prisma.paymentAttempt.findMany({ where: { feeId: setup.fee.id } });
      expect(attempts).toHaveLength(1);
      expect(attempts[0].status).toBe("FAILED");
      expect(attempts[0].failureReason).toContain("Fake gateway rejected");
    });

    it("expires the old PENDING checkout when the gateway has no record of it", async () => {
      const app = await createTestApp();
      const setup = await createTutorFeeFixture();
      const headers = await getAuthHeaders(setup.tutorAccount);

      const first = JSON.parse((await checkout(app, headers, setup.fee.id)).body);
      const second = await checkout(app, headers, setup.fee.id);

      expect(second.statusCode).toBe(201);
      const secondTran = JSON.parse(second.body).tranId;
      const oldRow = await prisma.paymentAttempt.findUniqueOrThrow({
        where: { tranId: first.tranId },
      });
      const newRow = await prisma.paymentAttempt.findUniqueOrThrow({
        where: { tranId: secondTran },
      });
      expect(oldRow.status).toBe("EXPIRED");
      expect(oldRow.failureReason).toBe("Replaced by a new checkout");
      expect(newRow.status).toBe("PENDING");
      expect(fake.sessions).toHaveLength(2);
    });

    it("ends the old checkout with the gateway's UNATTEMPTED status and starts a new one", async () => {
      const app = await createTestApp();
      const setup = await createTutorFeeFixture();
      const headers = await getAuthHeaders(setup.tutorAccount);
      const first = JSON.parse((await checkout(app, headers, setup.fee.id)).body);
      fake.setQuery(first.tranId, [gatewayRecord(first.tranId, "UNATTEMPTED")]);

      const second = await checkout(app, headers, setup.fee.id);

      expect(second.statusCode).toBe(201);
      const oldRow = await prisma.paymentAttempt.findUniqueOrThrow({
        where: { tranId: first.tranId },
      });
      expect(oldRow.status).toBe("EXPIRED");
      expect(oldRow.failureReason).toBe("Gateway status UNATTEMPTED");
      expect(
        await prisma.paymentAttempt.count({ where: { feeId: setup.fee.id, status: "PENDING" } }),
      ).toBe(1);
    });

    it("replaces a checkout the gateway reports as PROCESSING while it is younger than 60 minutes", async () => {
      const app = await createTestApp();
      const setup = await createTutorFeeFixture();
      const headers = await getAuthHeaders(setup.tutorAccount);
      const first = JSON.parse((await checkout(app, headers, setup.fee.id)).body);
      fake.setQuery(first.tranId, [gatewayRecord(first.tranId, "PROCESSING")]);

      const second = await checkout(app, headers, setup.fee.id);

      expect(second.statusCode).toBe(201);
      const oldRow = await prisma.paymentAttempt.findUniqueOrThrow({
        where: { tranId: first.tranId },
      });
      expect(oldRow.status).toBe("EXPIRED");
      expect(oldRow.failureReason).toBe("Replaced by a new checkout");
    });

    it("answers 409 'This fee was just paid.' when the gateway shows the old checkout paid", async () => {
      const app = await createTestApp();
      const setup = await createTutorFeeFixture();
      const headers = await getAuthHeaders(setup.tutorAccount);
      const first = JSON.parse((await checkout(app, headers, setup.fee.id)).body);
      const paid = fakeSuccess({ tranId: first.tranId, valId: "VAL-OLD", amount: "1537.50" });
      fake.setQuery(first.tranId, [paid]);
      fake.setValidation("VAL-OLD", paid);

      const second = await checkout(app, headers, setup.fee.id);

      expect(second.statusCode).toBe(409);
      expect(JSON.parse(second.body).message).toBe("This fee was just paid.");
      const fee = await prisma.platformFee.findUniqueOrThrow({ where: { id: setup.fee.id } });
      expect(fee.status).toBe("PAID");
      const ledger = await prisma.feePayment.findMany({ where: { feeId: setup.fee.id } });
      expect(ledger).toHaveLength(1);
      const oldRow = await prisma.paymentAttempt.findUniqueOrThrow({
        where: { tranId: first.tranId },
      });
      expect(oldRow.status).toBe("SUCCEEDED");
      expect(await prisma.paymentAttempt.count({ where: { feeId: setup.fee.id } })).toBe(1);
    });

    it("returns 503 and keeps the old checkout PENDING when the gateway query is unavailable", async () => {
      const app = await createTestApp();
      const setup = await createTutorFeeFixture();
      const headers = await getAuthHeaders(setup.tutorAccount);
      const first = JSON.parse((await checkout(app, headers, setup.fee.id)).body);
      fake.failNext("unavailable");

      const second = await checkout(app, headers, setup.fee.id);

      expect(second.statusCode).toBe(503);
      expect(JSON.parse(second.body).code).toBe("GATEWAY_UNAVAILABLE");
      const oldRow = await prisma.paymentAttempt.findUniqueOrThrow({
        where: { tranId: first.tranId },
      });
      expect(oldRow.status).toBe("PENDING");
      expect(await prisma.paymentAttempt.count({ where: { feeId: setup.fee.id } })).toBe(1);
    });

    it("lets only one of two concurrent starts leave a PENDING attempt", async () => {
      const setup = await createTutorFeeFixture();

      const results = await Promise.allSettled([
        startCheckout(setup.tutorAccount.id, setup.fee.id),
        startCheckout(setup.tutorAccount.id, setup.fee.id),
      ]);

      expect(results.some((r) => r.status === "fulfilled")).toBe(true);
      for (const r of results) {
        if (r.status === "rejected") {
          expect(r.reason).toMatchObject({ code: "INVALID_FEE_STATE" });
        }
      }
      const pending = await prisma.paymentAttempt.count({
        where: { feeId: setup.fee.id, status: "PENDING" },
      });
      expect(pending).toBe(1);
    });

    it("quotes only the remaining balance after a partial payment", async () => {
      const app = await createTestApp();
      const setup = await createTutorFeeFixture(1500);
      const admin = await createSuperAdmin();
      await createFeePayment({ feeId: setup.fee.id, amount: 500, recordedById: admin.id });

      const res = await checkout(app, await getAuthHeaders(setup.tutorAccount), setup.fee.id);

      expect(res.statusCode).toBe(201);
      expect(JSON.parse(res.body)).toMatchObject({
        feeAmount: "1000.00",
        chargeAmount: "25.00",
        totalAmount: "1025.00",
      });
    });
  });

  describe("GET /api/v1/fees/:id/attempts/:tranId", () => {
    it("returns the attempt and the fee balance to the owner", async () => {
      const app = await createTestApp();
      const setup = await createTutorFeeFixture();
      const headers = await getAuthHeaders(setup.tutorAccount);
      const { tranId } = JSON.parse((await checkout(app, headers, setup.fee.id)).body);

      const res = await app.inject({
        method: "GET",
        url: attemptUrl(setup.fee.id, tranId),
        headers,
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe("private, no-store");
      const body = JSON.parse(res.body);
      expect(body).toMatchObject({
        tranId,
        status: "PENDING",
        feeAmount: "1500.00",
        chargeAmount: "37.50",
        totalAmount: "1537.50",
        failureReason: null,
        settledAt: null,
        fee: { status: "DUE", amountDue: "1500.00", amountPaid: "0.00", remaining: "1500.00" },
      });
    });

    it("returns 404 to another tutor", async () => {
      const app = await createTestApp();
      const setup = await createTutorFeeFixture();
      const { tranId } = JSON.parse(
        (await checkout(app, await getAuthHeaders(setup.tutorAccount), setup.fee.id)).body,
      );
      const other = await createAccount({ role: "TUTOR" });
      await createTutorProfile(other.id);

      const res = await app.inject({
        method: "GET",
        url: attemptUrl(setup.fee.id, tranId),
        headers: await getAuthHeaders(other),
      });

      expect(res.statusCode).toBe(404);
    });

    it("returns 404 for a tranId that belongs to a different fee", async () => {
      const app = await createTestApp();
      const setup = await createTutorFeeFixture();
      const headers = await getAuthHeaders(setup.tutorAccount);
      const otherFee = await createPlatformFee({
        tutorId: setup.tutor.id,
        applicationId: setup.application.id,
        feeType: "OTHER",
        amountDue: 500,
      });
      const { tranId } = JSON.parse((await checkout(app, headers, otherFee.id)).body);

      const res = await app.inject({
        method: "GET",
        url: attemptUrl(setup.fee.id, tranId),
        headers,
      });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).message).toBe("Payment not found");
    });

    it("reconciles a stale PENDING attempt on read and returns SUCCEEDED", async () => {
      const app = await createTestApp();
      const setup = await createTutorFeeFixture();
      const headers = await getAuthHeaders(setup.tutorAccount);
      const { tranId } = JSON.parse((await checkout(app, headers, setup.fee.id)).body);
      await prisma.paymentAttempt.update({
        where: { tranId },
        data: { createdAt: new Date(Date.now() - 30_000) },
      });
      const paid = fakeSuccess({ tranId, valId: "VAL-GET", amount: "1537.50" });
      fake.setQuery(tranId, [paid]);
      fake.setValidation("VAL-GET", paid);

      const res = await app.inject({
        method: "GET",
        url: attemptUrl(setup.fee.id, tranId),
        headers,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe("SUCCEEDED");
      expect(body.settledAt).not.toBeNull();
      expect(body.fee).toMatchObject({ status: "PAID", remaining: "0.00" });
    });

    it("still returns 200 PENDING when the gateway is down during the read", async () => {
      const app = await createTestApp();
      const setup = await createTutorFeeFixture();
      const headers = await getAuthHeaders(setup.tutorAccount);
      const { tranId } = JSON.parse((await checkout(app, headers, setup.fee.id)).body);
      await prisma.paymentAttempt.update({
        where: { tranId },
        data: { createdAt: new Date(Date.now() - 30_000) },
      });
      fake.failNext("unavailable");

      const res = await app.inject({
        method: "GET",
        url: attemptUrl(setup.fee.id, tranId),
        headers,
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).status).toBe("PENDING");
    });
  });

  describe("GET attempt on read, gateway statuses", () => {
    it("keeps a checkout the gateway reports as PROCESSING PENDING while it is younger than 60 minutes", async () => {
      const app = await createTestApp();
      const setup = await createTutorFeeFixture();
      const headers = await getAuthHeaders(setup.tutorAccount);
      const { tranId } = JSON.parse((await checkout(app, headers, setup.fee.id)).body);
      await prisma.paymentAttempt.update({
        where: { tranId },
        data: { createdAt: new Date(Date.now() - 30_000) },
      });
      fake.setQuery(tranId, [gatewayRecord(tranId, "PROCESSING")]);

      const res = await app.inject({
        method: "GET",
        url: attemptUrl(setup.fee.id, tranId),
        headers,
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({ status: "PENDING", failureReason: null });
    });

    it("expires a checkout the gateway reports as PROCESSING once it is older than 60 minutes", async () => {
      const app = await createTestApp();
      const setup = await createTutorFeeFixture();
      const headers = await getAuthHeaders(setup.tutorAccount);
      const { tranId } = JSON.parse((await checkout(app, headers, setup.fee.id)).body);
      await prisma.paymentAttempt.update({
        where: { tranId },
        data: { createdAt: new Date(Date.now() - 61 * 60_000) },
      });
      fake.setQuery(tranId, [gatewayRecord(tranId, "PROCESSING")]);

      const res = await app.inject({
        method: "GET",
        url: attemptUrl(setup.fee.id, tranId),
        headers,
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({
        status: "EXPIRED",
        failureReason: "No completed payment at the gateway after 60 minutes",
      });
    });
  });

  describe("settlement and ledger rules", () => {
    it("settles a partial fee for the remaining balance and marks it PAID", async () => {
      const setup = await createTutorFeeFixture(1500);
      const admin = await createSuperAdmin();
      await createFeePayment({ feeId: setup.fee.id, amount: 500, recordedById: admin.id });
      const app = await createTestApp();
      const { tranId, totalAmount } = JSON.parse(
        (await checkout(app, await getAuthHeaders(setup.tutorAccount), setup.fee.id)).body,
      );
      expect(totalAmount).toBe("1025.00");
      const paid = fakeSuccess({ tranId, valId: "VAL-PART", amount: "1025.00" });
      fake.setValidation("VAL-PART", paid);

      const attempt = await settleAttempt(tranId, "VAL-PART");

      expect(attempt?.status).toBe("SUCCEEDED");
      const fee = await prisma.platformFee.findUniqueOrThrow({ where: { id: setup.fee.id } });
      expect(fee.status).toBe("PAID");
      expect(fee.amountPaid.toFixed(2)).toBe("1500.00");
      const gatewayRow = await prisma.feePayment.findFirstOrThrow({
        where: { feeId: setup.fee.id, method: "SSLCOMMERZ" },
      });
      expect(gatewayRow.amount.toFixed(2)).toBe("1000.00");
    });

    it("recognises the one-PENDING-per-fee violation from Prisma and from the raw message", async () => {
      const setup = await createTutorFeeFixture();
      const base = {
        feeId: setup.fee.id,
        tutorId: setup.tutor.id,
        feeAmount: "1500.00",
        chargeAmount: "0.00",
        totalAmount: "1500.00",
      };
      await prisma.paymentAttempt.create({ data: { ...base, tranId: "TMFIRSTPENDING1" } });

      const err = await prisma.paymentAttempt
        .create({ data: { ...base, tranId: "TMSECONDPENDING" } })
        .catch((e: unknown) => e);

      expect(isPendingConflict(err)).toBe(true);
      expect(isPendingConflict(new Error("unique_violation on payment_attempt"))).toBe(true);
      // The raw driver-adapter shape, with the Postgres message under cause.
      expect(
        isPendingConflict(
          new Error("Driver error", {
            cause: {
              originalCode: "23505",
              originalMessage: `duplicate key value violates unique constraint "${PENDING_INDEX}"`,
            },
          }),
        ),
      ).toBe(true);
      expect(
        isPendingConflict(
          new Error("Driver error", {
            cause: {
              originalCode: "23505",
              originalMessage:
                'duplicate key value violates unique constraint "payment_attempt_tran_id_key"',
            },
          }),
        ),
      ).toBe(false);
      expect(isPendingConflict(new Error("some other failure"))).toBe(false);
    });
  });
});
