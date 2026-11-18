import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { prisma } from "../../lib/prisma.js";
import {
  createAccount,
  createFeePayment,
  createSuperAdmin,
  createTestApp,
  createTutorFeeFixture,
  getAuthHeaders,
  setPlatformSetting,
} from "../../tests/helpers.js";

const FEES_URL = "/api/v1/fees";
const DAY_MS = 24 * 60 * 60 * 1000;

type Fixture = Awaited<ReturnType<typeof createTutorFeeFixture>>;

// A settled SSLCommerz payment on the fee, written directly: a PAYMENT row plus a SUCCEEDED attempt
// that points at it. The attempt's fee part is 1500.00 and its charge 37.50, so the refund is 1500.00.
async function settledOnlinePayment(
  fixture: Fixture,
  opts: { settledAt?: Date; bankTranId?: string | null } = {},
) {
  const tranId = `TM${crypto.randomUUID().replace(/-/g, "").slice(0, 20).toUpperCase()}`;
  const settledAt = opts.settledAt ?? new Date();
  const payment = await prisma.feePayment.create({
    data: {
      feeId: fixture.fee.id,
      kind: "PAYMENT",
      amount: 1500,
      method: "SSLCOMMERZ",
      txnReference: tranId,
      receivedAt: settledAt,
      recordedById: null,
    },
  });
  const attempt = await prisma.paymentAttempt.create({
    data: {
      feeId: fixture.fee.id,
      tutorId: fixture.tutor.id,
      tranId,
      feeAmount: 1500,
      chargeAmount: 37.5,
      totalAmount: 1537.5,
      status: "SUCCEEDED",
      bankTranId: opts.bankTranId === undefined ? `BANK-${tranId}` : opts.bankTranId,
      settledAt,
      paymentId: payment.id,
    },
  });
  return { payment, attempt };
}

function requestRefund(
  app: Awaited<ReturnType<typeof createTestApp>>,
  headers: Record<string, string>,
  feeId: string,
  payload: Record<string, unknown>,
) {
  return app.inject({ method: "POST", url: `${FEES_URL}/${feeId}/refunds`, headers, payload });
}

const VALID_REASON = "Charged twice for the same placement";

describe("POST /api/v1/fees/:id/refunds", () => {
  it("creates a REQUESTED refund of the fee part and shows it on the fee", async () => {
    const app = await createTestApp();
    const fixture = await createTutorFeeFixture(1500);
    const { payment, attempt } = await settledOnlinePayment(fixture);

    const res = await requestRefund(app, fixture.tutorHeaders, fixture.fee.id, {
      paymentId: payment.id,
      reason: `  ${VALID_REASON}  `,
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.refunds).toEqual([
      {
        id: expect.any(String),
        paymentId: payment.id,
        amount: "1500.00",
        status: "REQUESTED",
        reason: VALID_REASON,
        createdAt: expect.any(String),
        completedAt: null,
        decisionNote: null,
      },
    ]);
    // An open refund hides the refund option on the payment.
    expect(
      body.payments.find((p: { id: string }) => p.id === payment.id).refundableUntil,
    ).toBeNull();

    const row = await prisma.paymentRefund.findFirstOrThrow({ where: { feeId: fixture.fee.id } });
    expect(row).toMatchObject({
      attemptId: attempt.id,
      tutorId: fixture.tutor.id,
      paymentId: payment.id,
      reversalId: null,
      source: "TUTOR",
      status: "REQUESTED",
      requestedById: fixture.tutorAccount.id,
      reason: VALID_REASON,
    });
    expect(row.amount.toFixed(2)).toBe("1500.00");
  });

  it("refuses a body with a short reason, an unknown field or a payment id that is not a uuid", async () => {
    const app = await createTestApp();
    const fixture = await createTutorFeeFixture(1500);
    const { payment } = await settledOnlinePayment(fixture);

    const shortReason = await requestRefund(app, fixture.tutorHeaders, fixture.fee.id, {
      paymentId: payment.id,
      reason: "ab",
    });
    const extraField = await requestRefund(app, fixture.tutorHeaders, fixture.fee.id, {
      paymentId: payment.id,
      reason: VALID_REASON,
      amount: 10,
    });
    const badId = await requestRefund(app, fixture.tutorHeaders, fixture.fee.id, {
      paymentId: "not-a-uuid",
      reason: VALID_REASON,
    });

    expect([shortReason.statusCode, extraField.statusCode, badId.statusCode]).toEqual([
      400, 400, 400,
    ]);
    expect(await prisma.paymentRefund.count()).toBe(0);
  });

  it("gives another tutor's fee 404 Fee not found", async () => {
    const app = await createTestApp();
    const mine = await createTutorFeeFixture(1500);
    const theirs = await createTutorFeeFixture(1500);
    const { payment } = await settledOnlinePayment(theirs);

    const res = await requestRefund(app, mine.tutorHeaders, theirs.fee.id, {
      paymentId: payment.id,
      reason: VALID_REASON,
    });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).message).toBe("Fee not found");
    expect(await prisma.paymentRefund.count()).toBe(0);
  });

  it("gives a payment of another fee 404 Payment not found", async () => {
    const app = await createTestApp();
    const fixture = await createTutorFeeFixture(1500);
    const other = await createTutorFeeFixture(1500);
    const { payment } = await settledOnlinePayment(other);

    const res = await requestRefund(app, fixture.tutorHeaders, fixture.fee.id, {
      paymentId: payment.id,
      reason: VALID_REASON,
    });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).message).toBe("Payment not found");
  });

  it("gives a student 403", async () => {
    const app = await createTestApp();
    const fixture = await createTutorFeeFixture(1500);
    const { payment } = await settledOnlinePayment(fixture);
    const student = await createAccount({ role: "STUDENT" });

    const res = await requestRefund(app, await getAuthHeaders(student), fixture.fee.id, {
      paymentId: payment.id,
      reason: VALID_REASON,
    });

    expect(res.statusCode).toBe(403);
  });

  it("refuses a cash payment with 409 REFUND_NOT_ALLOWED", async () => {
    const app = await createTestApp();
    const fixture = await createTutorFeeFixture(1500);
    const admin = await createSuperAdmin();
    const cash = await createFeePayment({
      feeId: fixture.fee.id,
      amount: 500,
      recordedById: admin.id,
    });

    const res = await requestRefund(app, fixture.tutorHeaders, fixture.fee.id, {
      paymentId: cash.id,
      reason: VALID_REASON,
    });

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({
      code: "REFUND_NOT_ALLOWED",
      message: "Only online payments can be refunded here.",
    });
  });

  it("refuses a payment settled 8 days ago with 409, and accepts one settled 6 days ago", async () => {
    const app = await createTestApp();
    const old = await createTutorFeeFixture(1500);
    const recent = await createTutorFeeFixture(1500);
    const { payment: oldPayment } = await settledOnlinePayment(old, {
      settledAt: new Date(Date.now() - 8 * DAY_MS),
    });
    const { payment: recentPayment } = await settledOnlinePayment(recent, {
      settledAt: new Date(Date.now() - 6 * DAY_MS),
    });

    const closed = await requestRefund(app, old.tutorHeaders, old.fee.id, {
      paymentId: oldPayment.id,
      reason: VALID_REASON,
    });
    const open = await requestRefund(app, recent.tutorHeaders, recent.fee.id, {
      paymentId: recentPayment.id,
      reason: VALID_REASON,
    });

    expect(closed.statusCode).toBe(409);
    expect(JSON.parse(closed.body).message).toBe("The refund window for this payment has closed.");
    expect(open.statusCode).toBe(201);
  });

  it("refuses every request when refund_window_days is 0", async () => {
    const app = await createTestApp();
    const fixture = await createTutorFeeFixture(1500);
    const { payment } = await settledOnlinePayment(fixture);
    await setPlatformSetting("refund_window_days", 0);

    const res = await requestRefund(app, fixture.tutorHeaders, fixture.fee.id, {
      paymentId: payment.id,
      reason: VALID_REASON,
    });

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).message).toBe("The refund window for this payment has closed.");
    expect(await prisma.paymentRefund.count()).toBe(0);
  });

  it("refuses a payment with no bank transaction id with 409", async () => {
    const app = await createTestApp();
    const fixture = await createTutorFeeFixture(1500);
    const { payment } = await settledOnlinePayment(fixture, { bankTranId: null });

    const res = await requestRefund(app, fixture.tutorHeaders, fixture.fee.id, {
      paymentId: payment.id,
      reason: VALID_REASON,
    });

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).message).toBe(
      "This payment has no bank transaction id. Refund it from the SSLCommerz merchant panel.",
    );
  });

  it("refuses a second request while one is open with 409", async () => {
    const app = await createTestApp();
    const fixture = await createTutorFeeFixture(1500);
    const { payment } = await settledOnlinePayment(fixture);
    const headers = fixture.tutorHeaders;
    const first = await requestRefund(app, headers, fixture.fee.id, {
      paymentId: payment.id,
      reason: VALID_REASON,
    });
    expect(first.statusCode).toBe(201);

    const second = await requestRefund(app, headers, fixture.fee.id, {
      paymentId: payment.id,
      reason: "Asking again",
    });

    expect(second.statusCode).toBe(409);
    expect(JSON.parse(second.body)).toMatchObject({
      code: "REFUND_NOT_ALLOWED",
      message: "A refund for this payment is already open.",
    });
    expect(await prisma.paymentRefund.count()).toBe(1);
  });

  it("refuses a payment whose fee part is already refunded with 409", async () => {
    const app = await createTestApp();
    const fixture = await createTutorFeeFixture(1500);
    const { payment, attempt } = await settledOnlinePayment(fixture);
    const admin = await createSuperAdmin();
    await prisma.paymentRefund.create({
      data: {
        attemptId: attempt.id,
        feeId: fixture.fee.id,
        tutorId: fixture.tutor.id,
        paymentId: payment.id,
        amount: 1500,
        reason: "Refunded earlier",
        source: "ADMIN",
        status: "SUCCEEDED",
        requestedById: admin.id,
        decidedById: admin.id,
        decidedAt: new Date(),
        completedAt: new Date(),
      },
    });

    const res = await requestRefund(app, fixture.tutorHeaders, fixture.fee.id, {
      paymentId: payment.id,
      reason: VALID_REASON,
    });

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).message).toBe("This payment has already been refunded.");
  });

  it("allows a new request after the earlier one was rejected", async () => {
    const app = await createTestApp();
    const fixture = await createTutorFeeFixture(1500);
    const { payment } = await settledOnlinePayment(fixture);
    const admin = await createSuperAdmin();
    const first = await requestRefund(app, fixture.tutorHeaders, fixture.fee.id, {
      paymentId: payment.id,
      reason: VALID_REASON,
    });
    expect(first.statusCode).toBe(201);
    await prisma.paymentRefund.update({
      where: { id: JSON.parse(first.body).refunds[0].id },
      data: {
        status: "REJECTED",
        decidedById: admin.id,
        decidedAt: new Date(),
        decisionNote: "Not eligible",
        completedAt: new Date(),
      },
    });

    const shown = await app.inject({
      method: "GET",
      url: `${FEES_URL}/${fixture.fee.id}`,
      headers: fixture.tutorHeaders,
    });
    expect(
      JSON.parse(shown.body).payments.find((p: { id: string }) => p.id === payment.id)
        .refundableUntil,
    ).not.toBeNull();

    const second = await requestRefund(app, fixture.tutorHeaders, fixture.fee.id, {
      paymentId: payment.id,
      reason: "Second request with more detail",
    });

    expect(second.statusCode).toBe(201);
    const body = JSON.parse(second.body);
    expect(body.refunds.map((r: { status: string }) => r.status)).toEqual([
      "REQUESTED",
      "REJECTED",
    ]);
    expect(body.refunds[1]).toMatchObject({ decisionNote: "Not eligible" });
  });
});
