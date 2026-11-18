import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import {
  createAccount,
  createAdmin,
  createApplication,
  createArea,
  createFeePayment,
  createPlatformFee,
  createRequirement,
  createStudentProfile,
  createTestApp,
  createTutorProfile,
  getAuthHeaders,
  setPlatformSetting,
} from "../../tests/helpers.js";

const FEES_URL = "/api/v1/fees";
const DAY_MS = 24 * 60 * 60 * 1000;

// A settled SSLCommerz payment on the fee: a PAYMENT row plus a SUCCEEDED attempt pointing at it.
async function settledOnlinePayment(feeId: string, tutorId: string, opts: { settledAt: Date }) {
  const tranId = `TM${crypto.randomUUID().replace(/-/g, "").slice(0, 20).toUpperCase()}`;
  const payment = await prisma.feePayment.create({
    data: {
      feeId,
      kind: "PAYMENT",
      amount: 1500,
      method: "SSLCOMMERZ",
      txnReference: tranId,
      receivedAt: opts.settledAt,
      recordedById: null,
    },
  });
  await prisma.paymentAttempt.create({
    data: {
      feeId,
      tutorId,
      tranId,
      feeAmount: 1500,
      chargeAmount: 37.5,
      totalAmount: 1537.5,
      status: "SUCCEEDED",
      bankTranId: `BANK-${tranId}`,
      settledAt: opts.settledAt,
      paymentId: payment.id,
    },
  });
  return { payment };
}

const ENV_KEYS = [
  "SSLC_STORE_ID",
  "SSLC_STORE_PASSWORD",
  "API_PUBLIC_URL",
  "WEB_PUBLIC_URL",
] as const;
let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, env[key]]));
  env.SSLC_STORE_ID = "teststore";
  env.SSLC_STORE_PASSWORD = "testpass";
  env.API_PUBLIC_URL = "http://api.test";
  env.WEB_PUBLIC_URL = "http://web.test";
  // Payments on, 2.5% gateway charge, unless a test changes it.
  await setPlatformSetting("online_payments_enabled", true);
  await setPlatformSetting("gateway_charge_percent", 2.5);
});

afterEach(() => {
  for (const key of ENV_KEYS) env[key] = savedEnv[key];
});

// A tutor with one CONFIRMED requirement application, so fees can be attached to it.
async function setupTutor(opts: { confirmedAt?: Date; studentName?: string } = {}) {
  const area = await createArea();
  const student = await createStudentProfile(
    (await createAccount({ role: "STUDENT" })).id,
    area.id,
    { name: opts.studentName ?? "Test Student" },
  );
  const tutorAccount = await createAccount({ role: "TUTOR" });
  const tutor = await createTutorProfile(tutorAccount.id);
  const requirement = await createRequirement({ studentId: student.id });
  const application = await createApplication({
    requirementId: requirement.id,
    tutorId: tutor.id,
    studentId: student.id,
    initiatedBy: "TUTOR",
    status: "CONFIRMED",
    confirmedAt: opts.confirmedAt,
  });
  return { tutorAccount, tutor, student, application };
}

type Setup = Awaited<ReturnType<typeof setupTutor>>;

// An OTHER fee (not limited per application) with an explicit createdAt, so the order is known.
async function makeFee(
  setup: Setup,
  overrides: {
    amountDue?: number;
    dueDate?: Date;
    status?: "DUE" | "WAIVED" | "VOID";
    createdAt?: Date;
  } = {},
) {
  const fee = await createPlatformFee({
    tutorId: setup.tutor.id,
    applicationId: setup.application.id,
    feeType: "OTHER",
    amountDue: overrides.amountDue,
    dueDate: overrides.dueDate,
    status: overrides.status,
  });
  if (overrides.createdAt) {
    await prisma.platformFee.update({
      where: { id: fee.id },
      data: { createdAt: overrides.createdAt },
    });
  }
  return fee;
}

async function makeAdmin() {
  return createAdmin({ status: "ACTIVE" });
}

async function getFee(
  headers: Record<string, string>,
  feeId: string,
): Promise<{ statusCode: number; body: string }> {
  const app = await createTestApp();
  const res = await app.inject({ method: "GET", url: `${FEES_URL}/${feeId}`, headers });
  return { statusCode: res.statusCode, body: res.body };
}

describe("tutor fees", () => {
  describe("GET /api/v1/fees/mine", () => {
    it("lists only the caller's fees, newest first, with amounts, remaining, overdue and unpaid", async () => {
      const app = await createTestApp();
      const admin = await makeAdmin();
      const confirmedAt = new Date(Date.now() - 30 * DAY_MS);
      const me = await setupTutor({ confirmedAt, studentName: "Ayesha Rahman" });
      const other = await setupTutor();
      const now = Date.now();

      // Overdue, unpaid, nothing paid.
      await makeFee(me, {
        amountDue: 1500,
        dueDate: new Date("2020-01-15T00:00:00.000Z"),
        createdAt: new Date(now - 3 * 60 * 60 * 1000),
      });
      // Fully paid, so not open.
      const paid = await makeFee(me, {
        amountDue: 800,
        dueDate: new Date("2099-01-01T00:00:00.000Z"),
        createdAt: new Date(now - 2 * 60 * 60 * 1000),
      });
      await createFeePayment({ feeId: paid.id, amount: 800, recordedById: admin.id });
      // Partly paid, due later, still open and unpaid.
      const partial = await makeFee(me, {
        amountDue: 1000,
        dueDate: new Date("2099-01-01T00:00:00.000Z"),
        createdAt: new Date(now - 60 * 60 * 1000),
      });
      await createFeePayment({ feeId: partial.id, amount: 400, recordedById: admin.id });
      // Another tutor's fee must not appear.
      await makeFee(other, { amountDue: 999 });

      const res = await app.inject({
        method: "GET",
        url: `${FEES_URL}/mine`,
        headers: await getAuthHeaders(me.tutorAccount),
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe("private, no-store");
      const body = JSON.parse(res.body);
      expect(body.nextCursor).toBeNull();
      expect(body.fees.map((f: { id: string }) => f.id)).toEqual([
        partial.id,
        paid.id,
        expect.any(String),
      ]);

      const [open, settled, overdue] = body.fees;
      expect(open).toMatchObject({
        id: partial.id,
        status: "PARTIAL",
        amountDue: "1000.00",
        amountPaid: "400.00",
        remaining: "600.00",
        dueDate: "2099-01-01",
        overdue: false,
        unpaid: true,
        feeType: "OTHER",
      });
      expect(settled).toMatchObject({
        id: paid.id,
        status: "PAID",
        amountPaid: "800.00",
        remaining: "0.00",
        overdue: false,
        unpaid: false,
      });
      expect(overdue).toMatchObject({
        status: "DUE",
        amountDue: "1500.00",
        remaining: "1500.00",
        dueDate: "2020-01-15",
        overdue: true,
        unpaid: true,
      });
      expect(overdue.application).toEqual({
        id: me.application.id,
        kind: "REQUIREMENT",
        confirmedAt: confirmedAt.toISOString(),
        packageTitle: null,
        studentName: "Ayesha Rahman",
      });
    });

    it("exposes only the list fields, not the note, tutor or payments", async () => {
      const app = await createTestApp();
      const me = await setupTutor();
      await makeFee(me, { amountDue: 500 });

      const res = await app.inject({
        method: "GET",
        url: `${FEES_URL}/mine`,
        headers: await getAuthHeaders(me.tutorAccount),
      });

      expect(res.statusCode).toBe(200);
      const [fee] = JSON.parse(res.body).fees;
      expect(Object.keys(fee).sort()).toEqual(
        [
          "amountDue",
          "amountPaid",
          "application",
          "createdAt",
          "dueDate",
          "feeType",
          "id",
          "overdue",
          "remaining",
          "status",
          "unpaid",
        ].sort(),
      );
    });

    it("returns an empty page for a tutor with no fees", async () => {
      const app = await createTestApp();
      const me = await setupTutor();

      const res = await app.inject({
        method: "GET",
        url: `${FEES_URL}/mine`,
        headers: await getAuthHeaders(me.tutorAccount),
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ fees: [], nextCursor: null });
    });

    it("pages 50 at a time and follows nextCursor to the last fee", async () => {
      const app = await createTestApp();
      const me = await setupTutor();
      const base = Date.now() - 60 * 60 * 1000;
      const ids: string[] = [];
      // OTHER fees are not limited per application. Index 0 is the newest.
      for (let i = 0; i < 51; i++) {
        const fee = await makeFee(me, { createdAt: new Date(base - i * 1000) });
        ids.push(fee.id);
      }
      const headers = await getAuthHeaders(me.tutorAccount);

      const first = await app.inject({ method: "GET", url: `${FEES_URL}/mine`, headers });
      expect(first.statusCode).toBe(200);
      const firstBody = JSON.parse(first.body);
      expect(firstBody.fees).toHaveLength(50);
      expect(firstBody.nextCursor).toEqual(expect.any(String));
      expect(firstBody.fees[0].id).toBe(ids[0]);

      const second = await app.inject({
        method: "GET",
        url: `${FEES_URL}/mine?cursor=${encodeURIComponent(firstBody.nextCursor)}`,
        headers,
      });
      expect(second.statusCode).toBe(200);
      const secondBody = JSON.parse(second.body);
      expect(secondBody.fees).toHaveLength(1);
      expect(secondBody.fees[0].id).toBe(ids[50]);
      expect(secondBody.nextCursor).toBeNull();

      const seen = [...firstBody.fees, ...secondBody.fees].map((f: { id: string }) => f.id);
      expect(new Set(seen).size).toBe(51);
      expect(seen).toEqual(ids);
    });

    it("rejects a malformed cursor with 400", async () => {
      const app = await createTestApp();
      const me = await setupTutor();

      const res = await app.inject({
        method: "GET",
        url: `${FEES_URL}/mine?cursor=not-a-real-cursor%21%21`,
        headers: await getAuthHeaders(me.tutorAccount),
      });

      expect(res.statusCode).toBe(400);
    });

    it("gives a student 403", async () => {
      const app = await createTestApp();
      const student = await createAccount({ role: "STUDENT" });

      const res = await app.inject({
        method: "GET",
        url: `${FEES_URL}/mine`,
        headers: await getAuthHeaders(student),
      });

      expect(res.statusCode).toBe(403);
    });

    it("rejects a request without a token with 401", async () => {
      const app = await createTestApp();

      const res = await app.inject({ method: "GET", url: `${FEES_URL}/mine` });

      expect(res.statusCode).toBe(401);
    });

    it("returns 404 Tutor profile not found for a tutor account without a profile", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });

      const res = await app.inject({
        method: "GET",
        url: `${FEES_URL}/mine`,
        headers: await getAuthHeaders(account),
      });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).message).toBe("Tutor profile not found");
    });
  });

  describe("GET /api/v1/fees/:id", () => {
    it("returns the fee with its payments in receivedAt order, without the recorder or txn reference", async () => {
      const app = await createTestApp();
      const admin = await makeAdmin();
      const me = await setupTutor();
      const fee = await makeFee(me, { amountDue: 1500 });
      // fee_payment is append-only, so receivedAt is set on insert. The later payment goes in
      // first, so the sort by receivedAt is what puts the 300.00 payment ahead.
      await prisma.feePayment.create({
        data: {
          feeId: fee.id,
          kind: "PAYMENT",
          amount: 200,
          method: "CASH",
          receivedAt: new Date(Date.now() - DAY_MS),
          recordedById: admin.id,
        },
      });
      await prisma.feePayment.create({
        data: {
          feeId: fee.id,
          kind: "PAYMENT",
          amount: 300,
          method: "CASH",
          receivedAt: new Date(Date.now() - 2 * DAY_MS),
          recordedById: admin.id,
        },
      });

      const res = await app.inject({
        method: "GET",
        url: `${FEES_URL}/${fee.id}`,
        headers: await getAuthHeaders(me.tutorAccount),
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe("private, no-store");
      expect(res.body).not.toContain(admin.id);
      const body = JSON.parse(res.body);
      expect(body.payments.map((p: { amount: string }) => p.amount)).toEqual(["300.00", "200.00"]);
      expect(Object.keys(body.payments[0]).sort()).toEqual(
        [
          "amount",
          "id",
          "kind",
          "method",
          "receivedAt",
          "refundableUntil",
          "reversesPaymentId",
        ].sort(),
      );
      expect(body.payments[0]).toMatchObject({ kind: "PAYMENT", method: "CASH" });
      expect(body.status).toBe("PARTIAL");
      expect(body.remaining).toBe("1000.00");
      expect(body.pendingAttempt).toBeNull();
    });

    it("returns 404 Fee not found for a fee that belongs to another tutor", async () => {
      const app = await createTestApp();
      const me = await setupTutor();
      const other = await setupTutor();
      const theirs = await makeFee(other, { amountDue: 700 });

      const res = await app.inject({
        method: "GET",
        url: `${FEES_URL}/${theirs.id}`,
        headers: await getAuthHeaders(me.tutorAccount),
      });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).message).toBe("Fee not found");
    });

    it("returns 404 for a fee that does not exist", async () => {
      const app = await createTestApp();
      const me = await setupTutor();

      const res = await app.inject({
        method: "GET",
        url: `${FEES_URL}/${crypto.randomUUID()}`,
        headers: await getAuthHeaders(me.tutorAccount),
      });

      expect(res.statusCode).toBe(404);
    });

    it("returns 400 for an id that is not a uuid", async () => {
      const app = await createTestApp();
      const me = await setupTutor();

      const res = await app.inject({
        method: "GET",
        url: `${FEES_URL}/not-a-uuid`,
        headers: await getAuthHeaders(me.tutorAccount),
      });

      expect(res.statusCode).toBe(400);
    });

    it("gives a student 403 and an anonymous caller 401", async () => {
      const app = await createTestApp();
      const me = await setupTutor();
      const fee = await makeFee(me, { amountDue: 500 });
      const student = await createAccount({ role: "STUDENT" });

      const asStudent = await app.inject({
        method: "GET",
        url: `${FEES_URL}/${fee.id}`,
        headers: await getAuthHeaders(student),
      });
      const anonymous = await app.inject({ method: "GET", url: `${FEES_URL}/${fee.id}` });

      expect(asStudent.statusCode).toBe(403);
      expect(anonymous.statusCode).toBe(401);
    });

    it("returns the PENDING attempt for this fee as pendingAttempt", async () => {
      const app = await createTestApp();
      const me = await setupTutor();
      const fee = await makeFee(me, { amountDue: 1500 });
      await prisma.paymentAttempt.create({
        data: {
          feeId: fee.id,
          tutorId: me.tutor.id,
          tranId: "TMTESTPENDING1",
          feeAmount: 1500,
          chargeAmount: 0,
          totalAmount: 1500,
          status: "PENDING",
        },
      });

      const res = await app.inject({
        method: "GET",
        url: `${FEES_URL}/${fee.id}`,
        headers: await getAuthHeaders(me.tutorAccount),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.pendingAttempt).toEqual({
        tranId: "TMTESTPENDING1",
        createdAt: expect.any(String),
      });
    });

    it("ignores attempts that are not PENDING", async () => {
      const app = await createTestApp();
      const me = await setupTutor();
      const fee = await makeFee(me, { amountDue: 1500 });
      await prisma.paymentAttempt.create({
        data: {
          feeId: fee.id,
          tutorId: me.tutor.id,
          tranId: "TMTESTFAILED01",
          feeAmount: 1500,
          chargeAmount: 0,
          totalAmount: 1500,
          status: "FAILED",
        },
      });

      const res = await app.inject({
        method: "GET",
        url: `${FEES_URL}/${fee.id}`,
        headers: await getAuthHeaders(me.tutorAccount),
      });

      expect(JSON.parse(res.body).pendingAttempt).toBeNull();
    });

    it("shows no refunds and no refundable payment on a fresh fee", async () => {
      const admin = await makeAdmin();
      const me = await setupTutor();
      const fee = await makeFee(me, { amountDue: 1500 });
      await createFeePayment({ feeId: fee.id, amount: 500, recordedById: admin.id });

      const res = await getFee(await getAuthHeaders(me.tutorAccount), fee.id);

      expect(JSON.parse(res.body)).toMatchObject({
        refunds: [],
        payments: [{ method: "CASH", refundableUntil: null }],
      });
    });

    it("marks a settled online payment refundable until its window closes", async () => {
      const me = await setupTutor();
      const fee = await makeFee(me, { amountDue: 1500 });
      const settledAt = new Date(Date.now() - DAY_MS);
      const { payment } = await settledOnlinePayment(fee.id, me.tutor.id, { settledAt });

      const res = await getFee(await getAuthHeaders(me.tutorAccount), fee.id);

      const body = JSON.parse(res.body);
      const shown = body.payments.find((p: { id: string }) => p.id === payment.id);
      expect(shown.method).toBe("SSLCOMMERZ");
      // The default window is 7 days after settlement.
      expect(new Date(shown.refundableUntil).getTime()).toBe(settledAt.getTime() + 7 * DAY_MS);
    });

    it("clears refundableUntil once the refund window has closed", async () => {
      const me = await setupTutor();
      const fee = await makeFee(me, { amountDue: 1500 });
      await settledOnlinePayment(fee.id, me.tutor.id, {
        settledAt: new Date(Date.now() - 8 * DAY_MS),
      });

      const res = await getFee(await getAuthHeaders(me.tutorAccount), fee.id);

      expect(JSON.parse(res.body).payments[0].refundableUntil).toBeNull();
    });

    it("shows a payment in REVIEW as held, blocks the quote with IN_REVIEW and allows no promo", async () => {
      const me = await setupTutor();
      const fee = await makeFee(me, { amountDue: 1500 });
      await prisma.paymentAttempt.create({
        data: {
          feeId: fee.id,
          tutorId: me.tutor.id,
          tranId: "TMTESTREVIEW01",
          feeAmount: 1500,
          chargeAmount: 37.5,
          totalAmount: 1537.5,
          status: "REVIEW",
          failureReason: "Gateway flagged the payment as risky (risk level 1)",
        },
      });

      const res = await getFee(await getAuthHeaders(me.tutorAccount), fee.id);

      const body = JSON.parse(res.body);
      expect(body.heldPayments).toEqual([
        {
          tranId: "TMTESTREVIEW01",
          status: "REVIEW",
          feeAmount: "1500.00",
          totalAmount: "1537.50",
          createdAt: expect.any(String),
        },
      ]);
      // The internal reason stays with the admins.
      expect(res.body).not.toContain("risk level");
      expect(body.checkout).toMatchObject({ enabled: false, unavailableReason: "IN_REVIEW" });
      expect(body.promoAllowed).toBe(false);
    });

    it("shows an UNAPPLIED payment as held until its refund succeeds", async () => {
      const admin = await makeAdmin();
      const me = await setupTutor();
      const fee = await makeFee(me, { amountDue: 1500, status: "WAIVED" });
      const attempt = await prisma.paymentAttempt.create({
        data: {
          feeId: fee.id,
          tutorId: me.tutor.id,
          tranId: "TMTESTUNAPPL01",
          feeAmount: 1500,
          chargeAmount: 37.5,
          totalAmount: 1537.5,
          status: "UNAPPLIED",
          bankTranId: "BANK-UNAPPLIED-1",
        },
      });
      const headers = await getAuthHeaders(me.tutorAccount);

      const before = JSON.parse((await getFee(headers, fee.id)).body);
      expect(before.heldPayments).toMatchObject([
        { tranId: "TMTESTUNAPPL01", status: "UNAPPLIED" },
      ]);

      await prisma.paymentRefund.create({
        data: {
          attemptId: attempt.id,
          feeId: fee.id,
          tutorId: me.tutor.id,
          amount: 1500,
          reason: "Fee was waived",
          source: "ADMIN",
          status: "SUCCEEDED",
          requestedById: admin.id,
          decidedById: admin.id,
          decidedAt: new Date(),
          completedAt: new Date(),
        },
      });

      const after = JSON.parse((await getFee(headers, fee.id)).body);
      expect(after.heldPayments).toEqual([]);
      expect(after.refunds).toHaveLength(1);
    });

    it("shows no promo and allows one on a fresh DUE fee", async () => {
      const me = await setupTutor();
      const fee = await makeFee(me, { amountDue: 1500 });

      const res = await getFee(await getAuthHeaders(me.tutorAccount), fee.id);

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({
        promo: null,
        promoAllowed: true,
        heldPayments: [],
      });
    });

    describe("checkout quote", () => {
      it("is null for a PAID fee", async () => {
        const admin = await makeAdmin();
        const me = await setupTutor();
        const fee = await makeFee(me, { amountDue: 600 });
        await createFeePayment({ feeId: fee.id, amount: 600, recordedById: admin.id });

        const { statusCode, body } = await getFee(await getAuthHeaders(me.tutorAccount), fee.id);

        expect(statusCode).toBe(200);
        expect(JSON.parse(body).checkout).toBeNull();
      });

      it("is null for a WAIVED fee", async () => {
        const me = await setupTutor();
        const fee = await makeFee(me, { amountDue: 600, status: "WAIVED" });

        const { body } = await getFee(await getAuthHeaders(me.tutorAccount), fee.id);

        expect(JSON.parse(body).checkout).toBeNull();
      });

      it("quotes a 2.5% charge on a 1500.00 fee", async () => {
        const me = await setupTutor();
        const fee = await makeFee(me, { amountDue: 1500 });

        const { statusCode, body } = await getFee(await getAuthHeaders(me.tutorAccount), fee.id);

        expect(statusCode).toBe(200);
        expect(JSON.parse(body).checkout).toEqual({
          enabled: true,
          unavailableReason: null,
          feeAmount: "1500.00",
          chargePercent: "2.50",
          chargeAmount: "37.50",
          totalAmount: "1537.50",
        });
      });

      it("quotes only the remaining amount on a PARTIAL fee", async () => {
        const admin = await makeAdmin();
        const me = await setupTutor();
        const fee = await makeFee(me, { amountDue: 1500 });
        await createFeePayment({ feeId: fee.id, amount: 500, recordedById: admin.id });

        const { body } = await getFee(await getAuthHeaders(me.tutorAccount), fee.id);

        expect(JSON.parse(body).checkout).toEqual({
          enabled: true,
          unavailableReason: null,
          feeAmount: "1000.00",
          chargePercent: "2.50",
          chargeAmount: "25.00",
          totalAmount: "1025.00",
        });
      });

      it("is disabled with PAYMENTS_OFF when online_payments_enabled is false", async () => {
        await setPlatformSetting("online_payments_enabled", false);
        const me = await setupTutor();
        const fee = await makeFee(me, { amountDue: 1500 });

        const { body } = await getFee(await getAuthHeaders(me.tutorAccount), fee.id);

        expect(JSON.parse(body).checkout).toMatchObject({
          enabled: false,
          unavailableReason: "PAYMENTS_OFF",
          totalAmount: "1537.50",
        });
      });

      it("is disabled with PAYMENTS_OFF when API_PUBLIC_URL is not set", async () => {
        env.API_PUBLIC_URL = undefined;
        const me = await setupTutor();
        const fee = await makeFee(me, { amountDue: 1500 });

        const { body } = await getFee(await getAuthHeaders(me.tutorAccount), fee.id);

        expect(JSON.parse(body).checkout).toMatchObject({
          enabled: false,
          unavailableReason: "PAYMENTS_OFF",
        });
      });

      it("is disabled with BELOW_MINIMUM when the remaining amount is 5.00", async () => {
        const me = await setupTutor();
        const fee = await makeFee(me, { amountDue: 5 });

        const { body } = await getFee(await getAuthHeaders(me.tutorAccount), fee.id);

        // 2.5% of 5.00 is 0.125, which rounds half up to 0.13. The total is 5.13, under the minimum.
        expect(JSON.parse(body).checkout).toEqual({
          enabled: false,
          unavailableReason: "BELOW_MINIMUM",
          feeAmount: "5.00",
          chargePercent: "2.50",
          chargeAmount: "0.13",
          totalAmount: "5.13",
        });
      });
    });
  });
});
