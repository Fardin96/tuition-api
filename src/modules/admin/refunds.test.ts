import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../lib/prisma.js";
import { setPaymentGatewayForTests } from "../../lib/sslcommerz.js";
import {
  createAccount,
  createAdmin,
  createFakeGateway,
  createSuperAdmin,
  createTestApp,
  createTutorFeeFixture,
  getAuthHeaders,
} from "../../tests/helpers.js";
import { newTranId } from "../fees/fee-quote.js";

const URL = "/api/v1/admin/refunds";
const MISSING_ID = "00000000-0000-7000-8000-000000000000";

type Fake = ReturnType<typeof createFakeGateway>;

// An online payment the gateway took: fee part on the ledger, attempt SUCCEEDED with a bank id.
async function succeededPayment(feeAmount = 1500) {
  const fixture = await createTutorFeeFixture(1500);
  const tranId = newTranId();
  const payment = await prisma.feePayment.create({
    data: {
      feeId: fixture.fee.id,
      kind: "PAYMENT",
      amount: feeAmount.toFixed(2),
      method: "SSLCOMMERZ",
      txnReference: tranId,
      receivedAt: new Date(),
    },
  });
  await prisma.paymentAttempt.create({
    data: {
      feeId: fixture.fee.id,
      tutorId: fixture.tutor.id,
      tranId,
      status: "SUCCEEDED",
      feeAmount: feeAmount.toFixed(2),
      chargeAmount: "37.50",
      totalAmount: (feeAmount + 37.5).toFixed(2),
      bankTranId: `BANK-${tranId}`,
      paymentId: payment.id,
      settledAt: new Date(),
    },
  });
  return { fixture, tranId };
}

// A refund row written directly, in any state.
async function refundRow(
  p: Awaited<ReturnType<typeof succeededPayment>>,
  data: {
    status: "REQUESTED" | "PROCESSING" | "NEEDS_REVIEW" | "SUCCEEDED" | "FAILED" | "REJECTED";
    refundRefId?: string | null;
    amount?: string;
    requestedById?: string;
    createdAt?: Date;
  },
) {
  const attempt = await prisma.paymentAttempt.findUniqueOrThrow({
    where: { tranId: p.tranId },
    select: { id: true, paymentId: true },
  });
  const decided = data.status !== "REQUESTED";
  const admin = await createSuperAdmin();
  return prisma.paymentRefund.create({
    data: {
      attemptId: attempt.id,
      feeId: p.fixture.fee.id,
      tutorId: p.fixture.tutor.id,
      paymentId: attempt.paymentId,
      amount: data.amount ?? "1500.00",
      reason: "Booked the wrong batch",
      source: data.status === "REQUESTED" ? "TUTOR" : "ADMIN",
      status: data.status,
      requestedById:
        data.requestedById ?? (data.status === "REQUESTED" ? p.fixture.tutorAccount.id : admin.id),
      decidedById: decided ? admin.id : null,
      decidedAt: decided ? new Date() : null,
      completedAt: ["SUCCEEDED", "FAILED", "REJECTED"].includes(data.status) ? new Date() : null,
      refundRefId: data.refundRefId ?? null,
      failureReason: data.status === "NEEDS_REVIEW" ? "The gateway's answer was unclear: x" : null,
      createdAt: data.createdAt,
    },
  });
}

describe("admin refunds", () => {
  let fake: Fake;

  beforeEach(() => {
    fake = createFakeGateway();
    setPaymentGatewayForTests(fake.gateway);
  });

  describe("GET /api/v1/admin/refunds", () => {
    it("rejects a request without a token with 401", async () => {
      const app = await createTestApp();
      const res = await app.inject({ method: "GET", url: URL });
      expect(res.statusCode).toBe(401);
    });

    it("rejects a tutor token with 403", async () => {
      const app = await createTestApp();
      const tutor = await createAccount({ role: "TUTOR" });
      const res = await app.inject({
        method: "GET",
        url: URL,
        headers: await getAuthHeaders(tutor),
      });
      expect(res.statusCode).toBe(403);
    });

    it("lets a plain admin read the list, with no-store caching", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const res = await app.inject({
        method: "GET",
        url: URL,
        headers: await getAuthHeaders(admin),
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe("private, no-store");
      expect(JSON.parse(res.body)).toEqual({ refunds: [], nextCursor: null });
    });

    it("filters on status and open, and pages with a cursor, newest first", async () => {
      const app = await createTestApp();
      const headers = await getAuthHeaders(await createAdmin({ status: "ACTIVE" }));
      const base = Date.now() - 60_000;
      const p1 = await succeededPayment();
      const p2 = await succeededPayment();
      const p3 = await succeededPayment();
      const oldest = await refundRow(p1, {
        status: "PROCESSING",
        refundRefId: "R-1",
        createdAt: new Date(base),
      });
      const middle = await refundRow(p2, { status: "FAILED", createdAt: new Date(base + 1000) });
      const newest = await refundRow(p3, { status: "REQUESTED", createdAt: new Date(base + 2000) });

      const open = await app.inject({ method: "GET", url: `${URL}?open=true`, headers });
      expect(JSON.parse(open.body).refunds.map((r: { id: string }) => r.id)).toEqual([
        newest.id,
        oldest.id,
      ]);

      const notOpen = await app.inject({ method: "GET", url: `${URL}?open=false`, headers });
      expect(JSON.parse(notOpen.body).refunds.map((r: { id: string }) => r.id)).toEqual([
        middle.id,
      ]);

      const failed = await app.inject({ method: "GET", url: `${URL}?status=FAILED`, headers });
      expect(JSON.parse(failed.body).refunds.map((r: { id: string }) => r.id)).toEqual([middle.id]);

      const byFee = await app.inject({
        method: "GET",
        url: `${URL}?feeId=${p1.fixture.fee.id}`,
        headers,
      });
      expect(JSON.parse(byFee.body).refunds.map((r: { id: string }) => r.id)).toEqual([oldest.id]);

      const firstPage = await app.inject({ method: "GET", url: `${URL}?limit=2`, headers });
      const first = JSON.parse(firstPage.body);
      expect(first.refunds.map((r: { id: string }) => r.id)).toEqual([newest.id, middle.id]);
      expect(first.nextCursor).not.toBeNull();

      const secondPage = await app.inject({
        method: "GET",
        url: `${URL}?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`,
        headers,
      });
      expect(JSON.parse(secondPage.body)).toMatchObject({
        refunds: [{ id: oldest.id }],
        nextCursor: null,
      });
    });

    it("rejects a bad limit with 400", async () => {
      const app = await createTestApp();
      const headers = await getAuthHeaders(await createAdmin({ status: "ACTIVE" }));
      const res = await app.inject({ method: "GET", url: `${URL}?limit=500`, headers });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("GET /api/v1/admin/refunds/:id", () => {
    it("returns the detail with the actions allowed right now", async () => {
      const app = await createTestApp();
      const headers = await getAuthHeaders(await createAdmin({ status: "ACTIVE" }));
      const p = await succeededPayment();
      const processing = await refundRow(p, { status: "PROCESSING", refundRefId: "R-7" });

      const res = await app.inject({ method: "GET", url: `${URL}/${processing.id}`, headers });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toMatchObject({
        id: processing.id,
        status: "PROCESSING",
        amount: "1500.00",
        refundRefId: "R-7",
        canApprove: false,
        canReject: false,
        canCheck: true,
        canResolve: false,
        attempt: { bankTranId: expect.any(String), feeAmount: "1500.00" },
        fee: { id: p.fixture.fee.id, amountPaid: "1500.00" },
        tutor: { id: p.fixture.tutor.id },
      });
      expect(body).toHaveProperty("gatewayResponse");
    });

    it("404 for an unknown refund and 400 for a malformed id", async () => {
      const app = await createTestApp();
      const headers = await getAuthHeaders(await createAdmin({ status: "ACTIVE" }));

      const missing = await app.inject({ method: "GET", url: `${URL}/${MISSING_ID}`, headers });
      expect(missing.statusCode).toBe(404);
      expect(JSON.parse(missing.body).code).toBe("NOT_FOUND");

      const malformed = await app.inject({ method: "GET", url: `${URL}/not-a-uuid`, headers });
      expect(malformed.statusCode).toBe(400);
    });
  });

  describe("POST /api/v1/admin/refunds", () => {
    it("a plain admin gets 403", async () => {
      const app = await createTestApp();
      const p = await succeededPayment();
      const res = await app.inject({
        method: "POST",
        url: URL,
        headers: await getAuthHeaders(await createAdmin({ status: "ACTIVE" })),
        payload: { tranId: p.tranId, reason: "Paid twice" },
      });
      expect(res.statusCode).toBe(403);
      expect(fake.refunds).toHaveLength(0);
    });

    it("a super admin starts the refund: 201, PROCESSING, the gateway is called", async () => {
      const app = await createTestApp();
      const headers = await getAuthHeaders(await createSuperAdmin());
      const p = await succeededPayment();

      const res = await app.inject({
        method: "POST",
        url: URL,
        headers,
        payload: { tranId: p.tranId, reason: "Paid twice", amount: "1000.00" },
      });

      expect(res.statusCode).toBe(201);
      expect(res.headers["cache-control"]).toBe("private, no-store");
      const body = JSON.parse(res.body);
      expect(body).toMatchObject({
        status: "PROCESSING",
        amount: "1000.00",
        refundRefId: "RREF-1",
        canCheck: true,
      });
      expect(fake.refunds).toHaveLength(1);
      expect(fake.refunds[0]).toMatchObject({ amount: "1000.00", refeId: body.id });
    });

    it("validates the body: short reason, zero amount and a bad tran id give 400", async () => {
      const app = await createTestApp();
      const headers = await getAuthHeaders(await createSuperAdmin());
      const p = await succeededPayment();

      const shortReason = await app.inject({
        method: "POST",
        url: URL,
        headers,
        payload: { tranId: p.tranId, reason: "no" },
      });
      expect(shortReason.statusCode).toBe(400);
      expect(JSON.parse(shortReason.body).code).toBe("VALIDATION_ERROR");

      const zero = await app.inject({
        method: "POST",
        url: URL,
        headers,
        payload: { tranId: p.tranId, reason: "Paid twice", amount: "0.00" },
      });
      expect(zero.statusCode).toBe(400);

      const badTran = await app.inject({
        method: "POST",
        url: URL,
        headers,
        payload: { tranId: "bad id!", reason: "Paid twice" },
      });
      expect(badTran.statusCode).toBe(400);
      expect(fake.refunds).toHaveLength(0);
    });

    it("409 REFUND_NOT_ALLOWED for an amount above what is refundable", async () => {
      const app = await createTestApp();
      const headers = await getAuthHeaders(await createSuperAdmin());
      const p = await succeededPayment();

      const res = await app.inject({
        method: "POST",
        url: URL,
        headers,
        payload: { tranId: p.tranId, reason: "Paid twice", amount: "1500.01" },
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).code).toBe("REFUND_NOT_ALLOWED");
    });

    it("404 for an unknown tran id", async () => {
      const app = await createTestApp();
      const headers = await getAuthHeaders(await createSuperAdmin());
      const res = await app.inject({
        method: "POST",
        url: URL,
        headers,
        payload: { tranId: "NOSUCHTRAN", reason: "Paid twice" },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("POST /api/v1/admin/refunds/:id/approve and /reject", () => {
    it("a plain admin cannot approve or reject (403)", async () => {
      const app = await createTestApp();
      const headers = await getAuthHeaders(await createAdmin({ status: "ACTIVE" }));
      const p = await succeededPayment();
      const requested = await refundRow(p, { status: "REQUESTED" });

      const approve = await app.inject({
        method: "POST",
        url: `${URL}/${requested.id}/approve`,
        headers,
      });
      expect(approve.statusCode).toBe(403);

      const reject = await app.inject({
        method: "POST",
        url: `${URL}/${requested.id}/reject`,
        headers,
        payload: { note: "Not allowed" },
      });
      expect(reject.statusCode).toBe(403);
      expect(fake.refunds).toHaveLength(0);
    });

    it("a super admin approves a requested refund without a body: 200, PROCESSING", async () => {
      const app = await createTestApp();
      const headers = await getAuthHeaders(await createSuperAdmin());
      const p = await succeededPayment();
      const requested = await refundRow(p, { status: "REQUESTED" });

      const res = await app.inject({
        method: "POST",
        url: `${URL}/${requested.id}/approve`,
        headers,
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({ status: "PROCESSING", refundRefId: "RREF-1" });
      expect(fake.refunds).toHaveLength(1);
    });

    it("a super admin declines a requested refund with a note: 200, REJECTED", async () => {
      const app = await createTestApp();
      const headers = await getAuthHeaders(await createSuperAdmin());
      const p = await succeededPayment();
      const requested = await refundRow(p, { status: "REQUESTED" });

      const res = await app.inject({
        method: "POST",
        url: `${URL}/${requested.id}/reject`,
        headers,
        payload: { note: "Lesson was delivered" },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({
        status: "REJECTED",
        decisionNote: "Lesson was delivered",
        canReject: false,
      });
    });

    it("409 INVALID_REFUND_STATE when the refund is not REQUESTED, and 400 for a short note", async () => {
      const app = await createTestApp();
      const headers = await getAuthHeaders(await createSuperAdmin());
      const p = await succeededPayment();
      const processing = await refundRow(p, { status: "PROCESSING", refundRefId: "R-3" });

      const approve = await app.inject({
        method: "POST",
        url: `${URL}/${processing.id}/approve`,
        headers,
      });
      expect(approve.statusCode).toBe(409);
      expect(JSON.parse(approve.body).code).toBe("INVALID_REFUND_STATE");

      const requested = await refundRow(await succeededPayment(), { status: "REQUESTED" });
      const shortNote = await app.inject({
        method: "POST",
        url: `${URL}/${requested.id}/reject`,
        headers,
        payload: { note: "no" },
      });
      expect(shortNote.statusCode).toBe(400);

      const reject = await app.inject({
        method: "POST",
        url: `${URL}/${processing.id}/reject`,
        headers,
        payload: { note: "Too late now" },
      });
      expect(reject.statusCode).toBe(409);
    });
  });

  describe("POST /api/v1/admin/refunds/:id/check", () => {
    it("a plain admin can check (200) and the refund completes with a reversal", async () => {
      const app = await createTestApp();
      const p = await succeededPayment();
      const processing = await refundRow(p, { status: "PROCESSING", refundRefId: "R-9" });
      fake.setRefundQuery("R-9", {
        status: "refunded",
        refundRefId: "R-9",
        refundedOn: "2026-11-18 10:00:00",
        errorReason: null,
        raw: {},
      });

      const res = await app.inject({
        method: "POST",
        url: `${URL}/${processing.id}/check`,
        headers: await getAuthHeaders(await createAdmin({ status: "ACTIVE" })),
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({ status: "SUCCEEDED", canCheck: false });
      const reversals = await prisma.feePayment.count({
        where: { feeId: p.fixture.fee.id, kind: "REVERSAL" },
      });
      expect(reversals).toBe(1);
    });

    it("a tutor cannot check (403)", async () => {
      const app = await createTestApp();
      const p = await succeededPayment();
      const processing = await refundRow(p, { status: "PROCESSING", refundRefId: "R-10" });
      const res = await app.inject({
        method: "POST",
        url: `${URL}/${processing.id}/check`,
        headers: await getAuthHeaders(p.fixture.tutorAccount),
      });
      expect(res.statusCode).toBe(403);
    });

    it("409 when the refund is not in progress; 503 when the gateway does not answer", async () => {
      const app = await createTestApp();
      const headers = await getAuthHeaders(await createSuperAdmin());
      const p = await succeededPayment();
      const requested = await refundRow(p, { status: "REQUESTED" });
      const notInProgress = await app.inject({
        method: "POST",
        url: `${URL}/${requested.id}/check`,
        headers,
      });
      expect(notInProgress.statusCode).toBe(409);

      const processing = await refundRow(await succeededPayment(), {
        status: "PROCESSING",
        refundRefId: "R-11",
      });
      fake.failNext("unavailable");
      const down = await app.inject({
        method: "POST",
        url: `${URL}/${processing.id}/check`,
        headers,
      });
      expect(down.statusCode).toBe(503);
      expect(JSON.parse(down.body).code).toBe("GATEWAY_UNAVAILABLE");
    });
  });

  describe("POST /api/v1/admin/refunds/:id/resolve", () => {
    async function needsReview() {
      const app = await createTestApp();
      const p = await succeededPayment();
      const row = await refundRow(p, { status: "NEEDS_REVIEW" });
      return { app, p, row };
    }

    it("a plain admin gets 403", async () => {
      const { app, row } = await needsReview();
      const res = await app.inject({
        method: "POST",
        url: `${URL}/${row.id}/resolve`,
        headers: await getAuthHeaders(await createAdmin({ status: "ACTIVE" })),
        payload: { outcome: "FAILED", note: "Bank shows nothing" },
      });
      expect(res.statusCode).toBe(403);
    });

    it("a super admin resolves SUCCEEDED with a reference: 200, the reversal is written", async () => {
      const { app, p, row } = await needsReview();

      const res = await app.inject({
        method: "POST",
        url: `${URL}/${row.id}/resolve`,
        headers: await getAuthHeaders(await createSuperAdmin()),
        payload: {
          outcome: "SUCCEEDED",
          refundRefId: "MANUAL-1",
          note: "Seen in the merchant panel",
        },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({
        status: "SUCCEEDED",
        refundRefId: "MANUAL-1",
        decisionNote: "Seen in the merchant panel",
      });
      expect(
        await prisma.feePayment.count({ where: { feeId: p.fixture.fee.id, kind: "REVERSAL" } }),
      ).toBe(1);
    });

    it("a super admin resolves FAILED: 200 with the note as the failure reason", async () => {
      const { app, p, row } = await needsReview();

      const res = await app.inject({
        method: "POST",
        url: `${URL}/${row.id}/resolve`,
        headers: await getAuthHeaders(await createSuperAdmin()),
        payload: { outcome: "FAILED", note: "Bank shows nothing" },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({
        status: "FAILED",
        failureReason: "Bank shows nothing",
      });
      expect(
        await prisma.feePayment.count({ where: { feeId: p.fixture.fee.id, kind: "REVERSAL" } }),
      ).toBe(0);
    });

    it("a reference is only accepted with SUCCEEDED (400), and a refund not in review is 409", async () => {
      const { app, row } = await needsReview();
      const headers = await getAuthHeaders(await createSuperAdmin());

      const refOnFailed = await app.inject({
        method: "POST",
        url: `${URL}/${row.id}/resolve`,
        headers,
        payload: { outcome: "FAILED", refundRefId: "MANUAL-2", note: "Bank shows nothing" },
      });
      expect(refOnFailed.statusCode).toBe(400);
      expect(JSON.parse(refOnFailed.body).code).toBe("VALIDATION_ERROR");

      const processing = await refundRow(await succeededPayment(), {
        status: "PROCESSING",
        refundRefId: "R-20",
      });
      const notReview = await app.inject({
        method: "POST",
        url: `${URL}/${processing.id}/resolve`,
        headers,
        payload: { outcome: "FAILED", note: "Not yet" },
      });
      expect(notReview.statusCode).toBe(409);
      expect(JSON.parse(notReview.body).code).toBe("INVALID_REFUND_STATE");
    });
  });
});
