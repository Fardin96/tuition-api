import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { setPaymentGatewayForTests } from "../lib/sslcommerz.js";
import { runPaymentReconcile } from "../modules/payment/payment-reconcile.service.js";
import { runRefundReconcile } from "../modules/refunds/refund-reconcile.service.js";
import {
  createFakeGateway,
  createSuperAdmin,
  createTestApp,
  createTutorFeeFixture,
  fakeSuccess,
  getAuthHeaders,
} from "./helpers.js";

// End-to-end payment journeys over the real HTTP routes (app.inject). Each user action is a request.
// Helpers only build fixtures, tokens and the fake gateway. The setup truncates every table before
// each test, so each journey is one `it` and starts from an empty database.

const ADMIN = "/api/v1/admin";
const TUTOR_FEES = "/api/v1/fees";
const CALLBACKS = "/api/v1/payments/sslcommerz";
const WEB = "http://web.test";

type App = Awaited<ReturnType<typeof createTestApp>>;
type Headers = Record<string, string>;

const savedEnv = {
  SSLC_STORE_ID: env.SSLC_STORE_ID,
  SSLC_STORE_PASSWORD: env.SSLC_STORE_PASSWORD,
  API_PUBLIC_URL: env.API_PUBLIC_URL,
  WEB_PUBLIC_URL: env.WEB_PUBLIC_URL,
};

// The SSLCommerz browser return and IPN post form-encoded bodies.
function gatewayPost(
  app: App,
  path: "success" | "fail" | "cancel" | "ipn",
  fields: Record<string, string>,
) {
  return app.inject({
    method: "POST",
    url: `${CALLBACKS}/${path}`,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams(fields).toString(),
  });
}

// Step 1 of journey 1. Journeys 2 and 3 open with it too, because each starts from an empty database.
async function turnOnPayments(app: App, headers: Headers) {
  const settings: [string, boolean | number][] = [
    ["online_payments_enabled", true],
    ["gateway_charge_percent", 2.5],
    ["refund_window_days", 7],
  ];
  for (const [key, value] of settings) {
    const res = await app.inject({
      method: "PUT",
      url: `${ADMIN}/settings/${key}`,
      headers,
      payload: { value },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ key, value });
  }
}

// The admin view of a fee, including the ledger rows and the gateway attempts.
async function adminFee(app: App, headers: Headers, feeId: string) {
  const res = await app.inject({ method: "GET", url: `${ADMIN}/fees/${feeId}`, headers });
  expect(res.statusCode).toBe(200);
  return JSON.parse(res.body);
}

describe("payments journey (API)", () => {
  let fake: ReturnType<typeof createFakeGateway>;

  beforeEach(() => {
    fake = createFakeGateway();
    setPaymentGatewayForTests(fake.gateway);
    env.SSLC_STORE_ID = "store_test";
    env.SSLC_STORE_PASSWORD = "pw_test_secret";
    env.API_PUBLIC_URL = "http://api.test";
    env.WEB_PUBLIC_URL = WEB;
  });

  afterEach(() => {
    setPaymentGatewayForTests(null);
    Object.assign(env, savedEnv);
  });

  it("journey 1: super admin sets up payments, a promo'd fee is paid online, refunded and waived (steps 1-9, audit 12)", async () => {
    const app = await createTestApp();
    // Fixtures: a super admin, and a tutor with a DUE placement fee of 1500.00.
    const admin = await createSuperAdmin();
    const adminHeaders = await getAuthHeaders(admin);
    const setup = await createTutorFeeFixture(1500);
    const tutorHeaders = await getAuthHeaders(setup.tutorAccount);
    const feeUrl = `${TUTOR_FEES}/${setup.fee.id}`;

    // 1. The super admin turns online payments on, sets the gateway charge to 2.5 and the refund window to 7 days.
    await turnOnPayments(app, adminHeaders);
    const settingsRes = await app.inject({
      method: "GET",
      url: `${ADMIN}/settings`,
      headers: adminHeaders,
    });
    expect(settingsRes.statusCode).toBe(200);
    expect(JSON.parse(settingsRes.body).settings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "online_payments_enabled", value: true }),
        expect.objectContaining({ key: "gateway_charge_percent", value: 2.5 }),
        expect.objectContaining({ key: "refund_window_days", value: 7 }),
      ]),
    );

    // 2. The tutor lists the fee and opens it. The quote is 1500.00 + 37.50 charge = 1537.50.
    const mineRes = await app.inject({
      method: "GET",
      url: `${TUTOR_FEES}/mine`,
      headers: tutorHeaders,
    });
    expect(mineRes.statusCode).toBe(200);
    expect(JSON.parse(mineRes.body).fees).toEqual([
      expect.objectContaining({ id: setup.fee.id, status: "DUE", amountDue: "1500.00" }),
    ]);
    const detailRes = await app.inject({ method: "GET", url: feeUrl, headers: tutorHeaders });
    expect(detailRes.statusCode).toBe(200);
    expect(JSON.parse(detailRes.body)).toMatchObject({
      amountDue: "1500.00",
      promo: null,
      promoAllowed: true,
      checkout: {
        enabled: true,
        unavailableReason: null,
        feeAmount: "1500.00",
        chargePercent: "2.50",
        chargeAmount: "37.50",
        totalAmount: "1537.50",
      },
    });

    // 3. The super admin creates WELCOME10 (10% off). The tutor applies it in lower case: 150.00 off,
    //    1350.00 due, 33.75 charge, 1383.75 total. Removing it restores 1500.00; applying it again gives 1350.00.
    const createdRes = await app.inject({
      method: "POST",
      url: `${ADMIN}/promo-codes`,
      headers: adminHeaders,
      payload: { code: "WELCOME10", discountType: "PERCENT", discountValue: 10 },
    });
    expect(createdRes.statusCode).toBe(201);
    expect(JSON.parse(createdRes.body)).toMatchObject({
      code: "WELCOME10",
      discountType: "PERCENT",
      discountValue: "10.00",
    });

    const appliedRes = await app.inject({
      method: "POST",
      url: `${feeUrl}/promo`,
      headers: tutorHeaders,
      payload: { code: "welcome10" },
    });
    expect(appliedRes.statusCode).toBe(200);
    expect(JSON.parse(appliedRes.body)).toMatchObject({
      amountDue: "1350.00",
      promo: { code: "WELCOME10", discountAmount: "150.00", originalAmount: "1500.00" },
      promoAllowed: false,
      checkout: { feeAmount: "1350.00", chargeAmount: "33.75", totalAmount: "1383.75" },
    });

    const removedRes = await app.inject({
      method: "DELETE",
      url: `${feeUrl}/promo`,
      headers: tutorHeaders,
    });
    expect(removedRes.statusCode).toBe(200);
    expect(JSON.parse(removedRes.body)).toMatchObject({
      amountDue: "1500.00",
      promo: null,
      checkout: { totalAmount: "1537.50" },
    });

    const reappliedRes = await app.inject({
      method: "POST",
      url: `${feeUrl}/promo`,
      headers: tutorHeaders,
      payload: { code: "WELCOME10" },
    });
    expect(reappliedRes.statusCode).toBe(200);
    expect(JSON.parse(reappliedRes.body)).toMatchObject({ amountDue: "1350.00" });

    // 4. The tutor starts checkout for the 1350.00 fee: 1383.75 total. The gateway session carries 1383.75.
    const checkoutRes = await app.inject({
      method: "POST",
      url: `${feeUrl}/checkout`,
      headers: tutorHeaders,
    });
    expect(checkoutRes.statusCode).toBe(201);
    const session = JSON.parse(checkoutRes.body);
    expect(session).toMatchObject({
      feeAmount: "1350.00",
      chargeAmount: "33.75",
      totalAmount: "1383.75",
    });
    expect(session.gatewayUrl).toContain(session.tranId);
    expect(fake.sessions).toHaveLength(1);
    expect(fake.sessions[0]).toMatchObject({ tranId: session.tranId, totalAmount: "1383.75" });
    const { tranId } = session as { tranId: string };
    const valId = "VAL-J1";

    // 5. The customer pays. The browser comes back with a success, then the IPN repeats it.
    fake.setValidation(valId, fakeSuccess({ tranId, valId, amount: "1383.75" }));
    const body = { tran_id: tranId, val_id: valId, status: "VALID" };

    const backRes = await gatewayPost(app, "success", body);
    expect(backRes.statusCode).toBe(303);
    expect(backRes.headers.location).toBe(
      `${WEB}/dashboard/fees/${setup.fee.id}/payment?tran=${tranId}`,
    );

    const ipnRes = await gatewayPost(app, "ipn", body);
    expect(ipnRes.statusCode).toBe(200);
    expect(JSON.parse(ipnRes.body)).toEqual({ received: true });

    // Exactly one ledger row for the fee part, the fee is PAID, and the attempt is SUCCEEDED.
    const paidDetail = JSON.parse(
      (await app.inject({ method: "GET", url: feeUrl, headers: tutorHeaders })).body,
    );
    expect(paidDetail).toMatchObject({ status: "PAID", amountPaid: "1350.00", remaining: "0.00" });
    const paidAdmin = await adminFee(app, adminHeaders, setup.fee.id);
    const paymentRows = paidAdmin.payments.filter((p: { kind: string }) => p.kind === "PAYMENT");
    expect(paymentRows).toEqual([
      expect.objectContaining({
        method: "SSLCOMMERZ",
        amount: "1350.00",
        txnReference: tranId,
      }),
    ]);
    const attemptRes = await app.inject({
      method: "GET",
      url: `${feeUrl}/attempts/${tranId}`,
      headers: tutorHeaders,
    });
    expect(attemptRes.statusCode).toBe(200);
    expect(JSON.parse(attemptRes.body)).toMatchObject({
      status: "SUCCEEDED",
      feeAmount: "1350.00",
      totalAmount: "1383.75",
      fee: { status: "PAID", remaining: "0.00" },
    });

    // 6. The super admin finds the payment in the attempts list, the 24-hour summary and the attempt detail.
    const succeededRes = await app.inject({
      method: "GET",
      url: `${ADMIN}/payment-attempts?status=SUCCEEDED`,
      headers: adminHeaders,
    });
    expect(succeededRes.statusCode).toBe(200);
    expect(JSON.parse(succeededRes.body).attempts).toEqual([
      expect.objectContaining({ tranId, status: "SUCCEEDED", feeAmount: "1350.00" }),
    ]);

    const summaryRes = await app.inject({
      method: "GET",
      url: `${ADMIN}/payment-attempts/summary`,
      headers: adminHeaders,
    });
    expect(summaryRes.statusCode).toBe(200);
    expect(JSON.parse(summaryRes.body)).toMatchObject({
      succeeded24h: 1,
      collected24h: "1350.00",
    });

    const attemptDetailRes = await app.inject({
      method: "GET",
      url: `${ADMIN}/payment-attempts/${tranId}`,
      headers: adminHeaders,
    });
    expect(attemptDetailRes.statusCode).toBe(200);
    expect(JSON.parse(attemptDetailRes.body)).toMatchObject({
      status: "SUCCEEDED",
      refundable: "1350.00",
    });

    // 7. The tutor sees a refund window on the payment and asks for a refund of the whole 1350.00.
    const withRefundWindow = JSON.parse(
      (await app.inject({ method: "GET", url: feeUrl, headers: tutorHeaders })).body,
    );
    const onlinePayment = withRefundWindow.payments.find(
      (p: { kind: string; method: string }) => p.kind === "PAYMENT" && p.method === "SSLCOMMERZ",
    );
    expect(onlinePayment.refundableUntil).toEqual(expect.any(String));

    const requestRes = await app.inject({
      method: "POST",
      url: `${feeUrl}/refunds`,
      headers: tutorHeaders,
      payload: { paymentId: onlinePayment.id, reason: "Paid twice by mistake" },
    });
    expect(requestRes.statusCode).toBe(201);
    const requested = JSON.parse(requestRes.body);
    expect(requested.refunds).toEqual([
      expect.objectContaining({ status: "REQUESTED", amount: "1350.00" }),
    ]);
    const refundId: string = requested.refunds[0].id;

    // 8. The super admin approves it. The gateway accepts it as RREF-1 (PROCESSING). The check then
    //    finds it refunded: the refund SUCCEEDED, a REVERSAL row is written, and the fee is DUE again.
    const approveRes = await app.inject({
      method: "POST",
      url: `${ADMIN}/refunds/${refundId}/approve`,
      headers: adminHeaders,
      payload: { note: "Duplicate charge confirmed" },
    });
    expect(approveRes.statusCode).toBe(200);
    expect(JSON.parse(approveRes.body)).toMatchObject({
      status: "PROCESSING",
      refundRefId: "RREF-1",
    });

    fake.setRefundQuery("RREF-1", {
      status: "refunded",
      refundRefId: "RREF-1",
      refundedOn: "2026-11-18",
      errorReason: null,
      raw: {},
    });
    const checkRes = await app.inject({
      method: "POST",
      url: `${ADMIN}/refunds/${refundId}/check`,
      headers: adminHeaders,
    });
    expect(checkRes.statusCode).toBe(200);
    expect(JSON.parse(checkRes.body)).toMatchObject({ status: "SUCCEEDED" });
    expect(JSON.parse(checkRes.body).reversalId).toEqual(expect.any(String));

    const reversedAdmin = await adminFee(app, adminHeaders, setup.fee.id);
    const reversals = reversedAdmin.payments.filter((p: { kind: string }) => p.kind === "REVERSAL");
    expect(reversals).toHaveLength(1);
    expect(reversals[0]).toMatchObject({ amount: "1350.00", method: "SSLCOMMERZ" });
    expect(reversedAdmin).toMatchObject({ status: "DUE", amountPaid: "0.00" });

    const afterRefund = JSON.parse(
      (await app.inject({ method: "GET", url: feeUrl, headers: tutorHeaders })).body,
    );
    expect(afterRefund).toMatchObject({ status: "DUE", amountPaid: "0.00", remaining: "1350.00" });
    expect(afterRefund.refunds).toEqual([
      expect.objectContaining({ id: refundId, status: "SUCCEEDED" }),
    ]);
    expect(
      afterRefund.payments.find((p: { kind: string }) => p.kind === "PAYMENT").refundableUntil,
    ).toBeNull();

    // 9. The super admin waives the fee.
    const waivedRes = await app.inject({
      method: "PATCH",
      url: `${ADMIN}/fees/${setup.fee.id}`,
      headers: adminHeaders,
      payload: { status: "WAIVED" },
    });
    expect(waivedRes.statusCode).toBe(200);
    expect(JSON.parse(waivedRes.body)).toMatchObject({ status: "WAIVED" });

    // 12. (journey 1 part) The audit log records the promo, the settings, the refund and the fee change.
    const auditRes = await app.inject({
      method: "GET",
      url: `${ADMIN}/audit-logs?limit=100`,
      headers: adminHeaders,
    });
    expect(auditRes.statusCode).toBe(200);
    const entries: { action: string; entityId: string }[] = JSON.parse(auditRes.body).entries;
    const actions = entries.map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "promo.create",
        "setting.update",
        "refund.approve",
        "refund.check",
        "fee.update",
      ]),
    );
    const settingKeys = entries.filter((e) => e.action === "setting.update").map((e) => e.entityId);
    expect(settingKeys).toEqual(
      expect.arrayContaining([
        "online_payments_enabled",
        "gateway_charge_percent",
        "refund_window_days",
      ]),
    );
  });

  it("journey 2: a checkout the gateway cannot reach, a session that fails, then a late success on the IPN (step 10)", async () => {
    const app = await createTestApp();
    const admin = await createSuperAdmin();
    const adminHeaders = await getAuthHeaders(admin);
    const setup = await createTutorFeeFixture(1500);
    const tutorHeaders = await getAuthHeaders(setup.tutorAccount);
    const feeUrl = `${TUTOR_FEES}/${setup.fee.id}`;
    // Opening: the same settings as journey 1 step 1 (the database is empty).
    await turnOnPayments(app, adminHeaders);

    // 10a. The gateway is down when the tutor starts checkout: 503, and no PENDING attempt is left behind.
    fake.failNext("unavailable");
    const downRes = await app.inject({
      method: "POST",
      url: `${feeUrl}/checkout`,
      headers: tutorHeaders,
    });
    expect(downRes.statusCode).toBe(503);
    expect(JSON.parse(downRes.body).code).toBe("GATEWAY_UNAVAILABLE");
    expect(
      await prisma.paymentAttempt.count({ where: { feeId: setup.fee.id, status: "PENDING" } }),
    ).toBe(0);
    const afterDown = JSON.parse(
      (await app.inject({ method: "GET", url: feeUrl, headers: tutorHeaders })).body,
    );
    expect(afterDown.pendingAttempt).toBeNull();

    // 10b. Checkout again works.
    const retryRes = await app.inject({
      method: "POST",
      url: `${feeUrl}/checkout`,
      headers: tutorHeaders,
    });
    expect(retryRes.statusCode).toBe(201);
    const { tranId } = JSON.parse(retryRes.body) as { tranId: string };
    expect(JSON.parse(retryRes.body)).toMatchObject({ totalAmount: "1537.50" });

    // 10c. The browser comes back on the fail URL: the gateway's session failed, so the attempt is FAILED.
    const failRes = await gatewayPost(app, "fail", {
      tran_id: tranId,
      error: "Card declined by issuer",
    });
    expect(failRes.statusCode).toBe(303);
    const failedAttempt = JSON.parse(
      (
        await app.inject({
          method: "GET",
          url: `${feeUrl}/attempts/${tranId}`,
          headers: tutorHeaders,
        })
      ).body,
    );
    expect(failedAttempt).toMatchObject({
      status: "FAILED",
      failureReason: "Card declined by issuer",
      fee: { status: "DUE" },
    });

    // 10d. The money does arrive: a validated success on the IPN still settles the failed attempt.
    const valId = "VAL-J2";
    fake.setValidation(valId, fakeSuccess({ tranId, valId, amount: "1537.50" }));
    const ipnRes = await gatewayPost(app, "ipn", {
      tran_id: tranId,
      val_id: valId,
      status: "VALID",
    });
    expect(ipnRes.statusCode).toBe(200);
    expect(JSON.parse(ipnRes.body)).toEqual({ received: true });

    const settled = await app.inject({
      method: "GET",
      url: `${feeUrl}/attempts/${tranId}`,
      headers: tutorHeaders,
    });
    expect(JSON.parse(settled.body)).toMatchObject({
      status: "SUCCEEDED",
      fee: { status: "PAID", remaining: "0.00" },
    });
    expect(await prisma.feePayment.count({ where: { feeId: setup.fee.id, kind: "PAYMENT" } })).toBe(
      1,
    );
  });

  it("journey 3: a payment with a mismatched amount is reviewed, rejected, refunded and reconciled by the crons (steps 11, 12)", async () => {
    const app = await createTestApp();
    const admin = await createSuperAdmin();
    const adminHeaders = await getAuthHeaders(admin);
    const setup = await createTutorFeeFixture(1500);
    const tutorHeaders = await getAuthHeaders(setup.tutorAccount);
    const feeUrl = `${TUTOR_FEES}/${setup.fee.id}`;
    // Opening: the same settings as journey 1 step 1 (the database is empty).
    await turnOnPayments(app, adminHeaders);

    // 11a. The tutor pays 1537.50. The gateway reports 1500.00 instead, so the success is held for review.
    const checkoutRes = await app.inject({
      method: "POST",
      url: `${feeUrl}/checkout`,
      headers: tutorHeaders,
    });
    expect(checkoutRes.statusCode).toBe(201);
    const { tranId } = JSON.parse(checkoutRes.body) as { tranId: string };
    const valId = "VAL-J3";
    fake.setValidation(valId, fakeSuccess({ tranId, valId, amount: "1500.00" }));
    const successRes = await gatewayPost(app, "success", {
      tran_id: tranId,
      val_id: valId,
      status: "VALID",
    });
    expect(successRes.statusCode).toBe(303);

    const reviewAttempt = await app.inject({
      method: "GET",
      url: `${feeUrl}/attempts/${tranId}`,
      headers: tutorHeaders,
    });
    expect(JSON.parse(reviewAttempt.body)).toMatchObject({
      status: "REVIEW",
      failureReason: "Gateway amount 1500.00 differs from 1537.50",
      fee: { status: "DUE", amountPaid: "0.00" },
    });

    // The super admin's attention queue lists it.
    const queueRes = await app.inject({
      method: "GET",
      url: `${ADMIN}/payment-attempts?attention=true`,
      headers: adminHeaders,
    });
    expect(JSON.parse(queueRes.body).attempts).toEqual([
      expect.objectContaining({ tranId, status: "REVIEW" }),
    ]);

    // 11b. The super admin rejects the review. The attempt is UNAPPLIED and the ledger stays empty.
    const rejectRes = await app.inject({
      method: "POST",
      url: `${ADMIN}/payment-attempts/${tranId}/review`,
      headers: adminHeaders,
      payload: { decision: "REJECT", note: "Amount does not match the quote" },
    });
    expect(rejectRes.statusCode).toBe(200);
    expect(JSON.parse(rejectRes.body)).toMatchObject({ status: "UNAPPLIED" });
    expect((await adminFee(app, adminHeaders, setup.fee.id)).payments).toEqual([]);

    // 11c. The super admin refunds the unapplied payment. The gateway accepts it as RREF-1 (PROCESSING).
    const refundRes = await app.inject({
      method: "POST",
      url: `${ADMIN}/refunds`,
      headers: adminHeaders,
      payload: { tranId, reason: "Gateway took the wrong amount" },
    });
    expect(refundRes.statusCode).toBe(201);
    expect(JSON.parse(refundRes.body)).toMatchObject({
      status: "PROCESSING",
      refundRefId: "RREF-1",
      amount: "1500.00",
    });
    const refundId: string = JSON.parse(refundRes.body).id;

    // 11d. The crons run. Nothing is left PENDING, and the gateway now says the refund was made.
    fake.setRefundQuery("RREF-1", {
      status: "refunded",
      refundRefId: "RREF-1",
      refundedOn: "2026-11-18",
      errorReason: null,
      raw: {},
    });
    const paymentRun = await runPaymentReconcile();
    expect(paymentRun).toMatchObject({ skipped: false, checked: 0 });
    const refundRun = await runRefundReconcile();
    expect(refundRun).toMatchObject({ skipped: false, checked: 1, succeeded: 1 });

    const refundAfter = await app.inject({
      method: "GET",
      url: `${ADMIN}/refunds/${refundId}`,
      headers: adminHeaders,
    });
    expect(JSON.parse(refundAfter.body)).toMatchObject({
      status: "SUCCEEDED",
      reversalId: null,
    });
    // UNAPPLIED had no ledger row, so the refund writes none.
    expect((await adminFee(app, adminHeaders, setup.fee.id)).payments).toEqual([]);
    const finalAttempt = await app.inject({
      method: "GET",
      url: `${ADMIN}/payment-attempts/${tranId}`,
      headers: adminHeaders,
    });
    expect(JSON.parse(finalAttempt.body)).toMatchObject({ status: "UNAPPLIED" });

    // 12. (journey 3 part) The audit log records the review and the refund created by the admin.
    const auditRes = await app.inject({
      method: "GET",
      url: `${ADMIN}/audit-logs?limit=100`,
      headers: adminHeaders,
    });
    const actions = (JSON.parse(auditRes.body).entries as { action: string }[]).map(
      (e) => e.action,
    );
    expect(actions).toEqual(expect.arrayContaining(["payment.review", "refund.create"]));
  });
});
