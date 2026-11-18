import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "../../config/env.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../lib/prisma.js";
import { setPaymentGatewayForTests } from "../../lib/sslcommerz.js";
import {
  createAdmin,
  createFakeGateway,
  createFeePayment,
  createPlatformFee,
  createSuperAdmin,
  createTestApp,
  createTutorFeeFixture,
  fakeSuccess,
  getAuthHeaders,
  setPlatformSetting,
} from "../../tests/helpers.js";

const LIST_URL = "/api/v1/admin/payment-attempts";
const SUMMARY_URL = `${LIST_URL}/summary`;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const savedEnv = {
  SSLC_STORE_ID: env.SSLC_STORE_ID,
  SSLC_STORE_PASSWORD: env.SSLC_STORE_PASSWORD,
  API_PUBLIC_URL: env.API_PUBLIC_URL,
  WEB_PUBLIC_URL: env.WEB_PUBLIC_URL,
};

type Fixture = Awaited<ReturnType<typeof createTutorFeeFixture>>;
type Status = "PENDING" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "EXPIRED" | "REVIEW" | "UNAPPLIED";

function newTranId() {
  return `T${crypto.randomBytes(8).toString("hex")}`;
}

type AttemptOptions = {
  status?: Status;
  tranId?: string;
  feeAmount?: number;
  chargeAmount?: number;
  createdAt?: Date;
  settledAt?: Date;
  lastCheckedAt?: Date;
  failureReason?: string;
  valId?: string;
  paymentId?: string;
  gatewayResponse?: Prisma.InputJsonValue;
};

// A payment attempt row written directly, so tests can set any status and timestamp.
async function makeAttempt(feeId: string, tutorId: string, opts: AttemptOptions = {}) {
  const feeAmount = opts.feeAmount ?? 1500;
  const chargeAmount = opts.chargeAmount ?? 37.5;
  return prisma.paymentAttempt.create({
    data: {
      feeId,
      tutorId,
      tranId: opts.tranId ?? newTranId(),
      status: opts.status ?? "PENDING",
      feeAmount: feeAmount.toFixed(2),
      chargeAmount: chargeAmount.toFixed(2),
      totalAmount: (feeAmount + chargeAmount).toFixed(2),
      failureReason: opts.failureReason,
      valId: opts.valId,
      paymentId: opts.paymentId,
      createdAt: opts.createdAt,
      settledAt: opts.settledAt,
      lastCheckedAt: opts.lastCheckedAt,
      gatewayResponse: opts.gatewayResponse,
    },
  });
}

// A SUCCEEDED attempt needs its ledger row first (payment_id is a foreign key).
async function makeSucceeded(
  feeId: string,
  tutorId: string,
  opts: { feeAmount: number; settledAt: Date; createdAt?: Date },
) {
  const tranId = newTranId();
  const payment = await prisma.feePayment.create({
    data: {
      feeId,
      kind: "PAYMENT",
      amount: opts.feeAmount.toFixed(2),
      method: "SSLCOMMERZ",
      txnReference: tranId,
      receivedAt: opts.settledAt,
    },
  });
  return makeAttempt(feeId, tutorId, {
    status: "SUCCEEDED",
    tranId,
    feeAmount: opts.feeAmount,
    chargeAmount: 0,
    paymentId: payment.id,
    settledAt: opts.settledAt,
    createdAt: opts.createdAt,
  });
}

// A second fee on the same application, for tests that need a second PENDING attempt.
async function extraFee(fixture: Fixture, amountDue = 5000) {
  return createPlatformFee({
    tutorId: fixture.tutor.id,
    applicationId: fixture.application.id,
    amountDue,
    feeType: "OTHER",
  });
}

describe("admin payment attempts", () => {
  let fake: ReturnType<typeof createFakeGateway>;

  beforeEach(() => {
    fake = createFakeGateway();
    setPaymentGatewayForTests(fake.gateway);
    env.SSLC_STORE_ID = "store_test";
    env.SSLC_STORE_PASSWORD = "pw_test_secret";
    env.API_PUBLIC_URL = "http://api.test";
    env.WEB_PUBLIC_URL = "http://web.test";
  });

  afterEach(() => {
    setPaymentGatewayForTests(null);
    Object.assign(env, savedEnv);
  });

  describe("GET /api/v1/admin/payment-attempts", () => {
    it("lists newest first, with money as 2-decimal strings and no gateway payload", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const fixture = await createTutorFeeFixture(1500);
      const older = await makeAttempt(fixture.fee.id, fixture.tutor.id, {
        status: "FAILED",
        createdAt: new Date("2026-11-01T10:00:00Z"),
        gatewayResponse: { status: "FAILED" },
      });
      const newer = await makeAttempt(fixture.fee.id, fixture.tutor.id, {
        status: "CANCELLED",
        createdAt: new Date("2026-11-02T10:00:00Z"),
      });

      const res = await app.inject({
        method: "GET",
        url: LIST_URL,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe("private, no-store");
      const body = JSON.parse(res.body);
      expect(body.nextCursor).toBeNull();
      expect(body.attempts.map((a: { tranId: string }) => a.tranId)).toEqual([
        newer.tranId,
        older.tranId,
      ]);
      expect(body.attempts[0]).toMatchObject({
        status: "CANCELLED",
        feeAmount: "1500.00",
        chargeAmount: "37.50",
        totalAmount: "1537.50",
        fee: {
          id: fixture.fee.id,
          status: "DUE",
          amountDue: "1500.00",
          amountPaid: "0.00",
        },
        tutor: { id: fixture.tutor.id, name: fixture.tutor.name },
      });
      expect(body.attempts[0]).not.toHaveProperty("gatewayResponse");
    });

    it("filters by status", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const fixture = await createTutorFeeFixture(1500);
      await makeAttempt(fixture.fee.id, fixture.tutor.id, { status: "FAILED" });
      await makeAttempt(fixture.fee.id, fixture.tutor.id, { status: "EXPIRED" });

      const res = await app.inject({
        method: "GET",
        url: `${LIST_URL}?status=EXPIRED`,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(200);
      const { attempts } = JSON.parse(res.body);
      expect(attempts).toHaveLength(1);
      expect(attempts[0].status).toBe("EXPIRED");
    });

    it("attention=true returns REVIEW and UNAPPLIED; attention=false returns the rest", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const fixture = await createTutorFeeFixture(1500);
      const review = await makeAttempt(fixture.fee.id, fixture.tutor.id, { status: "REVIEW" });
      const unapplied = await makeAttempt(fixture.fee.id, fixture.tutor.id, {
        status: "UNAPPLIED",
      });
      const failed = await makeAttempt(fixture.fee.id, fixture.tutor.id, { status: "FAILED" });
      const headers = await getAuthHeaders(admin);

      const flagged = JSON.parse(
        (await app.inject({ method: "GET", url: `${LIST_URL}?attention=true`, headers })).body,
      );
      const rest = JSON.parse(
        (await app.inject({ method: "GET", url: `${LIST_URL}?attention=false`, headers })).body,
      );

      expect(flagged.attempts.map((a: { tranId: string }) => a.tranId).sort()).toEqual(
        [review.tranId, unapplied.tranId].sort(),
      );
      expect(rest.attempts.map((a: { tranId: string }) => a.tranId)).toEqual([failed.tranId]);
    });

    it("filters by feeId and tutorId", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const first = await createTutorFeeFixture(1500);
      const second = await createTutorFeeFixture(1500);
      const mine = await makeAttempt(first.fee.id, first.tutor.id, { status: "FAILED" });
      await makeAttempt(second.fee.id, second.tutor.id, { status: "FAILED" });
      const headers = await getAuthHeaders(admin);

      const byFee = JSON.parse(
        (await app.inject({ method: "GET", url: `${LIST_URL}?feeId=${first.fee.id}`, headers }))
          .body,
      );
      const byTutor = JSON.parse(
        (
          await app.inject({
            method: "GET",
            url: `${LIST_URL}?tutorId=${second.tutor.id}`,
            headers,
          })
        ).body,
      );

      expect(byFee.attempts.map((a: { tranId: string }) => a.tranId)).toEqual([mine.tranId]);
      expect(byTutor.attempts).toHaveLength(1);
      expect(byTutor.attempts[0].tutor.id).toBe(second.tutor.id);
    });

    it("paginates with nextCursor, without repeats", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const fixture = await createTutorFeeFixture(1500);
      const base = Date.parse("2026-11-01T00:00:00Z");
      const made = [];
      for (let i = 0; i < 3; i++) {
        made.push(
          await makeAttempt(fixture.fee.id, fixture.tutor.id, {
            status: "FAILED",
            createdAt: new Date(base + i * HOUR_MS),
          }),
        );
      }
      const headers = await getAuthHeaders(admin);

      const first = JSON.parse(
        (await app.inject({ method: "GET", url: `${LIST_URL}?limit=2`, headers })).body,
      );
      expect(first.attempts.map((a: { tranId: string }) => a.tranId)).toEqual([
        made[2].tranId,
        made[1].tranId,
      ]);
      expect(first.nextCursor).toEqual(expect.any(String));

      const second = JSON.parse(
        (
          await app.inject({
            method: "GET",
            url: `${LIST_URL}?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`,
            headers,
          })
        ).body,
      );
      expect(second.attempts.map((a: { tranId: string }) => a.tranId)).toEqual([made[0].tranId]);
      expect(second.nextCursor).toBeNull();
    });

    it("rejects an invalid cursor and an unknown status with 400", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const headers = await getAuthHeaders(admin);

      const badCursor = await app.inject({
        method: "GET",
        url: `${LIST_URL}?cursor=not-a-cursor`,
        headers,
      });
      const badStatus = await app.inject({
        method: "GET",
        url: `${LIST_URL}?status=BOGUS`,
        headers,
      });

      expect(badCursor.statusCode).toBe(400);
      expect(badStatus.statusCode).toBe(400);
    });

    it("no token gets 401, a tutor token gets 403", async () => {
      const app = await createTestApp();
      const fixture = await createTutorFeeFixture(1500);

      const anonymous = await app.inject({ method: "GET", url: LIST_URL });
      const tutor = await app.inject({
        method: "GET",
        url: LIST_URL,
        headers: await getAuthHeaders(fixture.tutorAccount),
      });

      expect(anonymous.statusCode).toBe(401);
      expect(tutor.statusCode).toBe(403);
    });
  });

  describe("GET /api/v1/admin/payment-attempts/summary", () => {
    it("counts what needs attention and sums the fees collected in the last 24 hours", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const fixture = await createTutorFeeFixture(1500);
      const now = Date.now();

      await makeAttempt(fixture.fee.id, fixture.tutor.id, { status: "REVIEW" });
      await makeAttempt(fixture.fee.id, fixture.tutor.id, { status: "UNAPPLIED" });
      // Stale: PENDING for two hours. The fresh PENDING on a second fee is not counted.
      await makeAttempt(fixture.fee.id, fixture.tutor.id, {
        status: "PENDING",
        createdAt: new Date(now - 2 * HOUR_MS),
      });
      const second = await extraFee(fixture);
      await makeAttempt(second.id, fixture.tutor.id, {
        status: "PENDING",
        createdAt: new Date(now - 10 * MINUTE_MS),
      });
      // Collected: one settled an hour ago counts, one settled three days ago does not.
      const thirdFee = await extraFee(fixture);
      const fourthFee = await extraFee(fixture);
      await makeSucceeded(thirdFee.id, fixture.tutor.id, {
        feeAmount: 1000.5,
        settledAt: new Date(now - HOUR_MS),
      });
      await makeSucceeded(fourthFee.id, fixture.tutor.id, {
        feeAmount: 500,
        settledAt: new Date(now - 3 * DAY_MS),
      });

      const res = await app.inject({
        method: "GET",
        url: SUMMARY_URL,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe("private, no-store");
      expect(JSON.parse(res.body)).toEqual({
        review: 1,
        unapplied: 1,
        stalePending: 1,
        succeeded24h: 1,
        collected24h: "1000.50",
      });
    });

    it("returns zeros and 0.00 when there is nothing to count", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });

      const res = await app.inject({
        method: "GET",
        url: SUMMARY_URL,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        review: 0,
        unapplied: 0,
        stalePending: 0,
        succeeded24h: 0,
        collected24h: "0.00",
      });
    });
  });

  describe("GET /api/v1/admin/payment-attempts/:tranId", () => {
    it("returns the attempt with its gateway response, canCheck and canReview", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const fixture = await createTutorFeeFixture(1500);
      const attempt = await makeAttempt(fixture.fee.id, fixture.tutor.id, {
        status: "PENDING",
        valId: "VAL-DETAIL",
        gatewayResponse: { status: "VALID", card_type: "VISA" },
      });

      const res = await app.inject({
        method: "GET",
        url: `${LIST_URL}/${attempt.tranId}`,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toMatchObject({
        tranId: attempt.tranId,
        status: "PENDING",
        totalAmount: "1537.50",
        valId: "VAL-DETAIL",
        gatewayResponse: { status: "VALID", card_type: "VISA" },
        canCheck: true,
        canReview: false,
        fee: { id: fixture.fee.id, amountDue: "1500.00" },
      });
    });

    it("shows a null gatewayResponse when the stored value is not an object", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const fixture = await createTutorFeeFixture(1500);
      const attempt = await makeAttempt(fixture.fee.id, fixture.tutor.id, {
        status: "FAILED",
        gatewayResponse: [1, 2, 3],
      });

      const res = await app.inject({
        method: "GET",
        url: `${LIST_URL}/${attempt.tranId}`,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).gatewayResponse).toBeNull();
    });

    it("canReview is true for REVIEW, and canCheck is false for a REVIEW attempt", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const fixture = await createTutorFeeFixture(1500);
      const attempt = await makeAttempt(fixture.fee.id, fixture.tutor.id, { status: "REVIEW" });

      const res = await app.inject({
        method: "GET",
        url: `${LIST_URL}/${attempt.tranId}`,
        headers: await getAuthHeaders(admin),
      });

      expect(JSON.parse(res.body)).toMatchObject({ canCheck: false, canReview: true });
    });

    it("canCheck is false for a FAILED attempt while payments are not configured", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const fixture = await createTutorFeeFixture(1500);
      const attempt = await makeAttempt(fixture.fee.id, fixture.tutor.id, { status: "FAILED" });
      env.SSLC_STORE_ID = undefined;

      const res = await app.inject({
        method: "GET",
        url: `${LIST_URL}/${attempt.tranId}`,
        headers: await getAuthHeaders(admin),
      });

      expect(JSON.parse(res.body)).toMatchObject({ canCheck: false, canReview: false });
    });

    it("unknown tran id returns 404", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });

      const res = await app.inject({
        method: "GET",
        url: `${LIST_URL}/NOSUCHTRAN`,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body)).toMatchObject({
        code: "NOT_FOUND",
        message: "Payment not found",
      });
    });
  });

  describe("POST /api/v1/admin/payment-attempts/:tranId/check", () => {
    it("refuses a final attempt with 409 and does not call the gateway", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const fixture = await createTutorFeeFixture(1500);
      const attempt = await makeSucceeded(fixture.fee.id, fixture.tutor.id, {
        feeAmount: 1500,
        settledAt: new Date(),
      });
      const tranId = attempt.tranId;
      fake.setQuery(tranId, [fakeSuccess({ tranId, valId: "VAL-FINAL", amount: "1500.00" })]);

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${tranId}/check`,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).code).toBe("INVALID_PAYMENT_STATE");
      const after = await prisma.paymentAttempt.findUniqueOrThrow({ where: { tranId } });
      expect(after.lastCheckedAt).toBeNull();
    });

    it("returns 503 PAYMENTS_DISABLED when payments are not configured", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const fixture = await createTutorFeeFixture(1500);
      const attempt = await makeAttempt(fixture.fee.id, fixture.tutor.id, { status: "FAILED" });
      env.SSLC_STORE_ID = undefined;

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${attempt.tranId}/check`,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body).code).toBe("PAYMENTS_DISABLED");
      const after = await prisma.paymentAttempt.findUniqueOrThrow({
        where: { tranId: attempt.tranId },
      });
      expect(after.status).toBe("FAILED");
    });

    it("returns 503 GATEWAY_UNAVAILABLE and leaves the status unchanged when the gateway fails", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const fixture = await createTutorFeeFixture(1500);
      const attempt = await makeAttempt(fixture.fee.id, fixture.tutor.id, {
        status: "PENDING",
        createdAt: new Date(Date.now() - 5 * MINUTE_MS),
      });
      fake.failNext("unavailable");

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${attempt.tranId}/check`,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body)).toMatchObject({
        code: "GATEWAY_UNAVAILABLE",
        message: "The payment gateway isn't responding. Try again in a few minutes.",
      });
      const after = await prisma.paymentAttempt.findUniqueOrThrow({
        where: { tranId: attempt.tranId },
      });
      expect(after.status).toBe("PENDING");
      const audits = await prisma.auditLog.count({
        where: { entityType: "payment_attempt", entityId: attempt.id },
      });
      expect(audits).toBe(0);
    });

    it("settles a PENDING attempt the gateway verified: one ledger row, fee PAID, payment.check audit", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const fixture = await createTutorFeeFixture(1500);
      const attempt = await makeAttempt(fixture.fee.id, fixture.tutor.id, {
        status: "PENDING",
        createdAt: new Date(Date.now() - 5 * MINUTE_MS),
      });
      const tranId = attempt.tranId;
      fake.setQuery(tranId, [fakeSuccess({ tranId, valId: "VAL-CHECK", amount: "1537.50" })]);
      fake.setValidation(
        "VAL-CHECK",
        fakeSuccess({ tranId, valId: "VAL-CHECK", amount: "1537.50" }),
      );

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${tranId}/check`,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toMatchObject({
        status: "SUCCEEDED",
        canCheck: false,
        canReview: false,
        valId: "VAL-CHECK",
        gatewayResponse: { status: "VALID" },
        fee: { status: "PAID", amountPaid: "1500.00" },
      });
      expect(body.paymentId).toEqual(expect.any(String));

      const ledger = await prisma.feePayment.findMany({
        where: { txnReference: tranId, method: "SSLCOMMERZ" },
      });
      expect(ledger).toHaveLength(1);
      expect(ledger[0].amount.toFixed(2)).toBe("1500.00");

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { entityType: "payment_attempt", entityId: attempt.id, action: "payment.check" },
      });
      expect(audit.actorAccountId).toBe(admin.id);
      expect(audit.before).toEqual({ status: "PENDING" });
      expect(audit.after).toEqual({ status: "SUCCEEDED" });
    });

    it("settles a FAILED attempt when the gateway later reports a verified success", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const fixture = await createTutorFeeFixture(1500);
      const attempt = await makeAttempt(fixture.fee.id, fixture.tutor.id, { status: "FAILED" });
      const tranId = attempt.tranId;
      fake.setQuery(tranId, [fakeSuccess({ tranId, valId: "VAL-LATE", amount: "1537.50" })]);
      fake.setValidation("VAL-LATE", fakeSuccess({ tranId, valId: "VAL-LATE", amount: "1537.50" }));

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${tranId}/check`,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).status).toBe("SUCCEEDED");
      const ledger = await prisma.feePayment.count({ where: { txnReference: tranId } });
      expect(ledger).toBe(1);
    });

    it("leaves a young PENDING attempt pending, sets lastCheckedAt and writes the audit row", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const fixture = await createTutorFeeFixture(1500);
      const attempt = await makeAttempt(fixture.fee.id, fixture.tutor.id, { status: "PENDING" });

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${attempt.tranId}/check`,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe("PENDING");
      expect(body.canCheck).toBe(true);
      expect(body.lastCheckedAt).toEqual(expect.any(String));
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { entityType: "payment_attempt", entityId: attempt.id, action: "payment.check" },
      });
      expect(audit.before).toEqual({ status: "PENDING" });
      expect(audit.after).toEqual({ status: "PENDING" });
    });

    it("expires a PENDING attempt older than 60 minutes that the gateway has never seen", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const fixture = await createTutorFeeFixture(1500);
      const attempt = await makeAttempt(fixture.fee.id, fixture.tutor.id, {
        status: "PENDING",
        createdAt: new Date(Date.now() - 2 * HOUR_MS),
      });

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${attempt.tranId}/check`,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(200);
      // EXPIRED is still settlable: a later verified success moves it on.
      expect(JSON.parse(res.body)).toMatchObject({
        status: "EXPIRED",
        failureReason: "No payment found at the gateway",
        canCheck: true,
      });
    });

    it("still checks while online payments are switched off", async () => {
      await setPlatformSetting("online_payments_enabled", false);
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const fixture = await createTutorFeeFixture(1500);
      const attempt = await makeAttempt(fixture.fee.id, fixture.tutor.id, {
        status: "PENDING",
        createdAt: new Date(Date.now() - 5 * MINUTE_MS),
      });
      const tranId = attempt.tranId;
      fake.setQuery(tranId, [fakeSuccess({ tranId, valId: "VAL-OFF", amount: "1537.50" })]);
      fake.setValidation("VAL-OFF", fakeSuccess({ tranId, valId: "VAL-OFF", amount: "1537.50" }));

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${tranId}/check`,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).status).toBe("SUCCEEDED");
    });

    it("a tutor token gets 403", async () => {
      const app = await createTestApp();
      const fixture = await createTutorFeeFixture(1500);
      const attempt = await makeAttempt(fixture.fee.id, fixture.tutor.id, { status: "FAILED" });

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${attempt.tranId}/check`,
        headers: await getAuthHeaders(fixture.tutorAccount),
      });

      expect(res.statusCode).toBe(403);
    });
  });

  describe("POST /api/v1/admin/payment-attempts/:tranId/review", () => {
    it("refuses an ordinary admin with 403 and leaves the attempt in REVIEW", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const fixture = await createTutorFeeFixture(1500);
      const attempt = await makeAttempt(fixture.fee.id, fixture.tutor.id, { status: "REVIEW" });

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${attempt.tranId}/review`,
        headers: await getAuthHeaders(admin),
        payload: { decision: "APPROVE", note: "Checked the bank statement" },
      });

      expect(res.statusCode).toBe(403);
      const after = await prisma.paymentAttempt.findUniqueOrThrow({
        where: { tranId: attempt.tranId },
      });
      expect(after.status).toBe("REVIEW");
    });

    it("refuses a tutor with 403", async () => {
      const app = await createTestApp();
      const fixture = await createTutorFeeFixture(1500);
      const attempt = await makeAttempt(fixture.fee.id, fixture.tutor.id, { status: "REVIEW" });

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${attempt.tranId}/review`,
        headers: await getAuthHeaders(fixture.tutorAccount),
        payload: { decision: "REJECT", note: "Not mine" },
      });

      expect(res.statusCode).toBe(403);
    });

    it("refuses an attempt that is not in REVIEW with 409 INVALID_PAYMENT_STATE", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();
      const fixture = await createTutorFeeFixture(1500);
      const attempt = await makeAttempt(fixture.fee.id, fixture.tutor.id, { status: "PENDING" });

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${attempt.tranId}/review`,
        headers: await getAuthHeaders(superAdmin),
        payload: { decision: "APPROVE", note: "Looks fine to me" },
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body)).toMatchObject({
        code: "INVALID_PAYMENT_STATE",
        message: "Only payments waiting for review can be decided.",
      });
    });

    it("unknown tran id returns 404", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/NOSUCHTRAN/review`,
        headers: await getAuthHeaders(superAdmin),
        payload: { decision: "REJECT", note: "No such payment" },
      });

      expect(res.statusCode).toBe(404);
    });

    it("APPROVE posts one ledger row recorded by the super admin, marks the fee PAID and writes payment.review", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();
      const fixture = await createTutorFeeFixture(1500);
      const attempt = await makeAttempt(fixture.fee.id, fixture.tutor.id, {
        status: "REVIEW",
        failureReason: "Gateway amount 1400.00 differs from 1537.50",
      });

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${attempt.tranId}/review`,
        headers: await getAuthHeaders(superAdmin),
        payload: { decision: "APPROVE", note: "Bank statement matches the fee" },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toMatchObject({
        status: "SUCCEEDED",
        failureReason: null,
        canReview: false,
        canCheck: false,
        fee: { status: "PAID", amountPaid: "1500.00" },
      });
      expect(body.paymentId).toEqual(expect.any(String));

      const ledger = await prisma.feePayment.findMany({
        where: { txnReference: attempt.tranId, method: "SSLCOMMERZ" },
      });
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({ feeId: fixture.fee.id, recordedById: superAdmin.id });
      expect(ledger[0].amount.toFixed(2)).toBe("1500.00");

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { entityType: "payment_attempt", entityId: attempt.id, action: "payment.review" },
      });
      expect(audit.actorAccountId).toBe(superAdmin.id);
      expect(audit.before).toEqual({
        status: "REVIEW",
        failureReason: "Gateway amount 1400.00 differs from 1537.50",
      });
      expect(audit.after).toEqual({
        status: "SUCCEEDED",
        decision: "APPROVE",
        note: "Bank statement matches the fee",
      });
    });

    it("APPROVE on a WAIVED fee makes the attempt UNAPPLIED with no ledger row", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();
      const fixture = await createTutorFeeFixture(1500);
      await prisma.platformFee.update({
        where: { id: fixture.fee.id },
        data: { status: "WAIVED" },
      });
      const attempt = await makeAttempt(fixture.fee.id, fixture.tutor.id, { status: "REVIEW" });

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${attempt.tranId}/review`,
        headers: await getAuthHeaders(superAdmin),
        payload: { decision: "APPROVE", note: "Paid, so approve it" },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({ status: "UNAPPLIED", paymentId: null });
      expect(JSON.parse(res.body).failureReason).toContain("WAIVED");
      const ledger = await prisma.feePayment.count({ where: { txnReference: attempt.tranId } });
      expect(ledger).toBe(0);
    });

    it("APPROVE on a fee that is already paid makes the attempt UNAPPLIED", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();
      const fixture = await createTutorFeeFixture(1500);
      await createFeePayment({ feeId: fixture.fee.id, amount: 1500, recordedById: superAdmin.id });
      const attempt = await makeAttempt(fixture.fee.id, fixture.tutor.id, { status: "REVIEW" });

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${attempt.tranId}/review`,
        headers: await getAuthHeaders(superAdmin),
        payload: { decision: "APPROVE", note: "Second payment, approve it" },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe("UNAPPLIED");
      expect(body.failureReason).toContain("more than the amount still due");
      const ledger = await prisma.feePayment.count({ where: { txnReference: attempt.tranId } });
      expect(ledger).toBe(0);
    });

    it("REJECT makes the attempt UNAPPLIED with the note, writes no ledger row and keeps the fee open", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();
      const fixture = await createTutorFeeFixture(1500);
      const attempt = await makeAttempt(fixture.fee.id, fixture.tutor.id, { status: "REVIEW" });

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${attempt.tranId}/review`,
        headers: await getAuthHeaders(superAdmin),
        payload: { decision: "REJECT", note: "Card was charged twice" },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({
        status: "UNAPPLIED",
        failureReason: "Rejected in review: Card was charged twice",
        paymentId: null,
        fee: { status: "DUE", amountPaid: "0.00" },
      });
      const ledger = await prisma.feePayment.count({ where: { txnReference: attempt.tranId } });
      expect(ledger).toBe(0);
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { entityType: "payment_attempt", entityId: attempt.id, action: "payment.review" },
      });
      expect(audit.after).toEqual({
        status: "UNAPPLIED",
        decision: "REJECT",
        note: "Card was charged twice",
      });
    });

    it("a second decision on the same attempt is refused with 409", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();
      const fixture = await createTutorFeeFixture(1500);
      const attempt = await makeAttempt(fixture.fee.id, fixture.tutor.id, { status: "REVIEW" });
      const headers = await getAuthHeaders(superAdmin);
      const first = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${attempt.tranId}/review`,
        headers,
        payload: { decision: "APPROVE", note: "Approved once" },
      });
      expect(first.statusCode).toBe(200);

      const second = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${attempt.tranId}/review`,
        headers,
        payload: { decision: "APPROVE", note: "Approved twice" },
      });

      expect(second.statusCode).toBe(409);
      const ledger = await prisma.feePayment.count({ where: { txnReference: attempt.tranId } });
      expect(ledger).toBe(1);
    });

    it("a note shorter than 3 characters returns 400", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();
      const fixture = await createTutorFeeFixture(1500);
      const attempt = await makeAttempt(fixture.fee.id, fixture.tutor.id, { status: "REVIEW" });

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${attempt.tranId}/review`,
        headers: await getAuthHeaders(superAdmin),
        payload: { decision: "REJECT", note: "ok" },
      });

      expect(res.statusCode).toBe(400);
    });
  });
});
