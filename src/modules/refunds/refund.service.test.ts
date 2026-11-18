import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../lib/prisma.js";
import { setPaymentGatewayForTests } from "../../lib/sslcommerz.js";
import { createFakeGateway, createSuperAdmin, createTutorFeeFixture } from "../../tests/helpers.js";
import { newTranId } from "../fees/fee-quote.js";
import {
  approveRefund,
  checkRefund,
  createAdminRefund,
  getRefund,
  rejectRefund,
  resolveRefund,
} from "./refund.service.js";

const NO_ANSWER =
  "No answer from the gateway. Check the merchant panel before doing anything else.";
const NO_BANK_ID =
  "This payment has no bank transaction id. Refund it from the SSLCommerz merchant panel.";

// An online payment the gateway took. SUCCEEDED puts the fee part on the ledger, UNAPPLIED does not,
// and PENDING is a checkout the gateway has not confirmed yet.
async function onlinePayment(
  status: "SUCCEEDED" | "UNAPPLIED" | "PENDING" = "SUCCEEDED",
  opts: { bankTranId?: string | null; feeAmount?: number } = {},
) {
  const fixture = await createTutorFeeFixture(1500);
  const feeAmount = opts.feeAmount ?? 1500;
  const tranId = newTranId();
  const bankTranId = opts.bankTranId === undefined ? `BANK-${tranId}` : opts.bankTranId;
  let paymentId: string | null = null;
  if (status === "SUCCEEDED") {
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
    paymentId = payment.id;
  }
  const attempt = await prisma.paymentAttempt.create({
    data: {
      feeId: fixture.fee.id,
      tutorId: fixture.tutor.id,
      tranId,
      status,
      feeAmount: feeAmount.toFixed(2),
      chargeAmount: "37.50",
      totalAmount: (feeAmount + 37.5).toFixed(2),
      bankTranId,
      paymentId,
      settledAt: status === "SUCCEEDED" ? new Date() : null,
    },
  });
  return { fixture, attempt, tranId, paymentId };
}

// A refund a tutor asked for: REQUESTED, waiting for a super admin.
async function requestedRefund(p: Awaited<ReturnType<typeof onlinePayment>>, amount = 1500) {
  return prisma.paymentRefund.create({
    data: {
      attemptId: p.attempt.id,
      feeId: p.fixture.fee.id,
      tutorId: p.fixture.tutor.id,
      paymentId: p.paymentId,
      amount: amount.toFixed(2),
      reason: "Booked the wrong batch",
      source: "TUTOR",
      status: "REQUESTED",
      requestedById: p.fixture.tutorAccount.id,
    },
  });
}

function refundedAnswer(refundRefId: string) {
  return {
    status: "refunded",
    refundRefId,
    refundedOn: "2026-11-18 10:00:00",
    errorReason: null,
    raw: { status: "refunded" },
  };
}

async function reversalsOf(feeId: string) {
  return prisma.feePayment.findMany({ where: { feeId, kind: "REVERSAL" } });
}

async function feeOf(feeId: string) {
  return prisma.platformFee.findUniqueOrThrow({ where: { id: feeId } });
}

async function actionsOf(refundId: string) {
  const rows = await prisma.auditLog.findMany({
    where: { entityType: "payment_refund", entityId: refundId },
    orderBy: { id: "asc" },
    select: { action: true },
  });
  return rows.map((row) => row.action);
}

describe("refund service", () => {
  let fake: ReturnType<typeof createFakeGateway>;
  let admin: { accountId: string };

  beforeEach(async () => {
    fake = createFakeGateway();
    setPaymentGatewayForTests(fake.gateway);
    const account = await createSuperAdmin();
    admin = { accountId: account.id };
  });

  describe("createAdminRefund", () => {
    it("starts a refund as PROCESSING and sends the bank id, amount and reason to the gateway", async () => {
      const p = await onlinePayment();

      const refund = await createAdminRefund(
        { tranId: p.tranId, reason: "Paid twice by mistake" },
        admin,
        "10.0.0.1",
      );

      expect(refund).toMatchObject({
        status: "PROCESSING",
        source: "ADMIN",
        amount: "1500.00",
        refundRefId: "RREF-1",
        decidedByName: "Test Super Admin",
        canCheck: true,
        canApprove: false,
      });
      expect(fake.refunds).toEqual([
        {
          bankTranId: p.attempt.bankTranId,
          amount: "1500.00",
          remarks: "Paid twice by mistake",
          refeId: refund.id,
        },
      ]);
      const row = await prisma.paymentRefund.findUniqueOrThrow({ where: { id: refund.id } });
      expect(row.paymentId).toBe(p.paymentId);
      expect(row.decidedById).toBe(admin.accountId);
      expect(row.requestedById).toBe(admin.accountId);
      expect(await actionsOf(refund.id)).toEqual(["refund.create"]);
    });

    it("a gateway 'failed' answer ends the refund as FAILED with its reason", async () => {
      const p = await onlinePayment();
      fake.setRefundAnswer({
        status: "failed",
        refundRefId: null,
        errorReason: "Refund window closed at the bank",
        raw: { status: "failed" },
      });

      const refund = await createAdminRefund(
        { tranId: p.tranId, reason: "Duplicate charge" },
        admin,
        undefined,
      );

      expect(refund).toMatchObject({
        status: "FAILED",
        failureReason: "Refund window closed at the bank",
        refundRefId: null,
        gatewayResponse: { status: "failed" },
        canResolve: false,
      });
      expect(refund.completedAt).not.toBeNull();
      expect(await reversalsOf(p.fixture.fee.id)).toHaveLength(0);
    });

    it("a refused request (GatewayError rejected) ends the refund as FAILED", async () => {
      const p = await onlinePayment();
      fake.failNext("rejected");

      const refund = await createAdminRefund(
        { tranId: p.tranId, reason: "Duplicate charge" },
        admin,
        undefined,
      );

      expect(refund).toMatchObject({ status: "FAILED", failureReason: "Fake gateway rejected" });
      expect(refund.completedAt).not.toBeNull();
    });

    it("an outage (GatewayError unavailable) leaves the refund in NEEDS_REVIEW, never FAILED", async () => {
      const p = await onlinePayment();
      fake.failNext("unavailable");

      const refund = await createAdminRefund(
        { tranId: p.tranId, reason: "Duplicate charge" },
        admin,
        undefined,
      );

      expect(refund).toMatchObject({
        status: "NEEDS_REVIEW",
        failureReason: NO_ANSWER,
        canResolve: true,
      });
      expect(refund.completedAt).toBeNull();
    });

    it("any other error while calling the gateway is also treated as no answer", async () => {
      const p = await onlinePayment();
      setPaymentGatewayForTests({
        ...fake.gateway,
        async initiateRefund() {
          throw new Error("socket hang up");
        },
      });

      const refund = await createAdminRefund(
        { tranId: p.tranId, reason: "Duplicate charge" },
        admin,
        undefined,
      );

      expect(refund).toMatchObject({ status: "NEEDS_REVIEW", failureReason: NO_ANSWER });
    });

    it("an answer that is not a clear success or failure goes to NEEDS_REVIEW", async () => {
      const p = await onlinePayment();
      fake.setRefundAnswer({
        status: "pending",
        refundRefId: "RREF-9",
        errorReason: null,
        raw: {},
      });

      const unclear = await createAdminRefund(
        { tranId: p.tranId, reason: "Duplicate charge" },
        admin,
        undefined,
      );

      expect(unclear).toMatchObject({
        status: "NEEDS_REVIEW",
        failureReason: "The gateway's answer was unclear: pending",
        refundRefId: null,
      });
    });

    it("a success without a gateway reference is not trusted", async () => {
      const p = await onlinePayment();
      fake.setRefundAnswer({ status: "success", refundRefId: null, errorReason: null, raw: {} });

      const refund = await createAdminRefund(
        { tranId: p.tranId, reason: "Duplicate charge" },
        admin,
        undefined,
      );

      expect(refund).toMatchObject({
        status: "NEEDS_REVIEW",
        failureReason: "The gateway's answer was unclear: success",
      });
    });

    it("refuses an amount above what is refundable, before anything is sent", async () => {
      const p = await onlinePayment();

      await expect(
        createAdminRefund(
          { tranId: p.tranId, amount: "1500.01", reason: "Too much" },
          admin,
          undefined,
        ),
      ).rejects.toMatchObject({ code: "REFUND_NOT_ALLOWED", statusCode: 409 });

      expect(fake.refunds).toHaveLength(0);
      expect(await prisma.paymentRefund.count()).toBe(0);
    });

    it("refuses a second refund while one is open", async () => {
      const p = await onlinePayment();
      await createAdminRefund(
        { tranId: p.tranId, amount: "500.00", reason: "First part" },
        admin,
        undefined,
      );

      await expect(
        createAdminRefund({ tranId: p.tranId, reason: "Second part" }, admin, undefined),
      ).rejects.toMatchObject({
        code: "REFUND_NOT_ALLOWED",
        statusCode: 409,
        message: "A refund for this payment is already open.",
      });
      expect(fake.refunds).toHaveLength(1);
    });

    it("refuses a payment without a bank transaction id", async () => {
      const p = await onlinePayment("SUCCEEDED", { bankTranId: null });

      await expect(
        createAdminRefund({ tranId: p.tranId, reason: "Duplicate charge" }, admin, undefined),
      ).rejects.toMatchObject({ code: "REFUND_NOT_ALLOWED", statusCode: 409, message: NO_BANK_ID });
      expect(fake.refunds).toHaveLength(0);
    });

    it("refuses a payment the gateway has not confirmed (PENDING)", async () => {
      const p = await onlinePayment("PENDING");

      await expect(
        createAdminRefund({ tranId: p.tranId, reason: "Duplicate charge" }, admin, undefined),
      ).rejects.toMatchObject({
        code: "REFUND_NOT_ALLOWED",
        statusCode: 409,
        message: "Only a payment the gateway took can be refunded.",
      });
    });

    it("404 for an unknown payment", async () => {
      await expect(
        createAdminRefund({ tranId: "NOSUCHTRAN", reason: "Duplicate charge" }, admin, undefined),
      ).rejects.toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
    });
  });

  describe("UNAPPLIED payments", () => {
    it("refunds money the ledger never took, and writes no ledger row", async () => {
      const p = await onlinePayment("UNAPPLIED");
      const refund = await createAdminRefund(
        { tranId: p.tranId, reason: "Fee was waived" },
        admin,
        undefined,
      );
      expect(refund).toMatchObject({ status: "PROCESSING", amount: "1500.00" });
      expect(refund.attempt.status).toBe("UNAPPLIED");

      fake.setRefundQuery("RREF-1", refundedAnswer("RREF-1"));
      await checkRefund(refund.id, admin);

      const done = await getRefund(refund.id);
      expect(done).toMatchObject({ status: "SUCCEEDED", reversalId: null });
      expect(await reversalsOf(p.fixture.fee.id)).toHaveLength(0);
      const fee = await feeOf(p.fixture.fee.id);
      expect(fee.status).toBe("DUE");
      expect(fee.amountPaid.toFixed(2)).toBe("0.00");
    });
  });

  describe("approve and reject", () => {
    it("approve: REQUESTED becomes PROCESSING with the admin as decider, and goes to the gateway", async () => {
      const p = await onlinePayment();
      const requested = await requestedRefund(p);

      const refund = await approveRefund(requested.id, "Checked the receipt", admin, "10.0.0.2");

      expect(refund).toMatchObject({
        status: "PROCESSING",
        refundRefId: "RREF-1",
        decidedByName: "Test Super Admin",
        decisionNote: "Checked the receipt",
        source: "TUTOR",
        requestedByName: p.fixture.tutor.name,
      });
      expect(fake.refunds).toHaveLength(1);
      expect(fake.refunds[0]).toMatchObject({
        bankTranId: p.attempt.bankTranId,
        refeId: requested.id,
      });
      expect(await actionsOf(requested.id)).toEqual(["refund.approve"]);
    });

    it("approve without a note leaves decisionNote empty", async () => {
      const p = await onlinePayment();
      const requested = await requestedRefund(p);

      const refund = await approveRefund(requested.id, undefined, admin, undefined);

      expect(refund).toMatchObject({ status: "PROCESSING", decisionNote: null });
    });

    it("approve of a refund that gateway refuses ends it as FAILED", async () => {
      const p = await onlinePayment();
      const requested = await requestedRefund(p);
      fake.failNext("rejected");

      const refund = await approveRefund(requested.id, undefined, admin, undefined);

      expect(refund).toMatchObject({ status: "FAILED", failureReason: "Fake gateway rejected" });
    });

    it("approve of a refund that is not REQUESTED is 409 INVALID_REFUND_STATE", async () => {
      const p = await onlinePayment();
      const started = await createAdminRefund(
        { tranId: p.tranId, reason: "Duplicate charge" },
        admin,
        undefined,
      );

      await expect(approveRefund(started.id, undefined, admin, undefined)).rejects.toMatchObject({
        code: "INVALID_REFUND_STATE",
        statusCode: 409,
      });
      expect(fake.refunds).toHaveLength(1);
    });

    it("reject: REQUESTED becomes REJECTED with the note and completed_at, and the gateway is not called", async () => {
      const p = await onlinePayment();
      const requested = await requestedRefund(p);

      const refund = await rejectRefund(requested.id, "Lesson was delivered", admin, "10.0.0.3");

      expect(refund).toMatchObject({
        status: "REJECTED",
        decisionNote: "Lesson was delivered",
        decidedByName: "Test Super Admin",
        canApprove: false,
      });
      expect(refund.completedAt).not.toBeNull();
      expect(fake.refunds).toHaveLength(0);
      expect(await actionsOf(requested.id)).toEqual(["refund.reject"]);
    });

    it("reject of a refund that is not REQUESTED is 409 INVALID_REFUND_STATE", async () => {
      const p = await onlinePayment();
      const started = await createAdminRefund(
        { tranId: p.tranId, reason: "Duplicate charge" },
        admin,
        undefined,
      );

      await expect(rejectRefund(started.id, "Too late", admin, undefined)).rejects.toMatchObject({
        code: "INVALID_REFUND_STATE",
        statusCode: 409,
      });
    });
  });

  describe("checkRefund", () => {
    async function startedRefund() {
      const p = await onlinePayment();
      const refund = await createAdminRefund(
        { tranId: p.tranId, reason: "Duplicate charge" },
        admin,
        undefined,
      );
      return { p, refund };
    }

    it("refunded: SUCCEEDED with one REVERSAL row, and the fee is due again", async () => {
      const { p, refund } = await startedRefund();
      expect((await feeOf(p.fixture.fee.id)).status).toBe("PAID");
      fake.setRefundQuery("RREF-1", refundedAnswer("RREF-1"));

      await checkRefund(refund.id, admin);

      const done = await getRefund(refund.id);
      expect(done).toMatchObject({ status: "SUCCEEDED", canCheck: false });
      expect(done.completedAt).not.toBeNull();
      const reversals = await reversalsOf(p.fixture.fee.id);
      expect(reversals).toHaveLength(1);
      expect(reversals[0]).toMatchObject({
        method: "SSLCOMMERZ",
        reversesPaymentId: p.paymentId,
        reason: "Refund RREF-1",
        recordedById: admin.accountId,
      });
      expect(reversals[0]?.amount.toFixed(2)).toBe("1500.00");
      expect(done.reversalId).toBe(reversals[0]?.id);
      const fee = await feeOf(p.fixture.fee.id);
      expect(fee.status).toBe("DUE");
      expect(fee.amountPaid.toFixed(2)).toBe("0.00");
      expect(await actionsOf(refund.id)).toEqual(["refund.create", "refund.check"]);
    });

    it("checking a finished refund again is 409 and writes no second reversal", async () => {
      const { p, refund } = await startedRefund();
      fake.setRefundQuery("RREF-1", refundedAnswer("RREF-1"));
      await checkRefund(refund.id, admin);

      await expect(checkRefund(refund.id, admin)).rejects.toMatchObject({
        code: "INVALID_REFUND_STATE",
        statusCode: 409,
      });
      expect(await reversalsOf(p.fixture.fee.id)).toHaveLength(1);
    });

    it("cancelled: FAILED with the gateway's reason, and no reversal", async () => {
      const { p, refund } = await startedRefund();
      fake.setRefundQuery("RREF-1", {
        status: "cancelled",
        refundRefId: "RREF-1",
        refundedOn: null,
        errorReason: "Cancelled by the bank",
        raw: {},
      });

      await checkRefund(refund.id, admin);

      const done = await getRefund(refund.id);
      expect(done).toMatchObject({ status: "FAILED", failureReason: "Cancelled by the bank" });
      expect(done.completedAt).not.toBeNull();
      expect(await reversalsOf(p.fixture.fee.id)).toHaveLength(0);
      expect((await feeOf(p.fixture.fee.id)).status).toBe("PAID");
    });

    it("still processing: the refund stays PROCESSING and last_checked_at is set", async () => {
      const { refund } = await startedRefund();

      await checkRefund(refund.id, admin);

      const done = await getRefund(refund.id);
      expect(done).toMatchObject({ status: "PROCESSING" });
      expect(done.lastCheckedAt).not.toBeNull();
    });

    it("gateway down: 503 GATEWAY_UNAVAILABLE, the refund is left alone, last_checked_at is set", async () => {
      const { refund } = await startedRefund();
      fake.failNext("unavailable");

      await expect(checkRefund(refund.id, admin)).rejects.toMatchObject({
        code: "GATEWAY_UNAVAILABLE",
        statusCode: 503,
      });
      const done = await getRefund(refund.id);
      expect(done.status).toBe("PROCESSING");
      expect(done.lastCheckedAt).not.toBeNull();
    });

    it("a refund whose fee was waived before completion succeeds without a reversal", async () => {
      const { p, refund } = await startedRefund();
      await prisma.platformFee.update({
        where: { id: p.fixture.fee.id },
        data: { status: "WAIVED" },
      });
      fake.setRefundQuery("RREF-1", refundedAnswer("RREF-1"));

      await checkRefund(refund.id, admin);

      const done = await getRefund(refund.id);
      expect(done).toMatchObject({ status: "SUCCEEDED", reversalId: null });
      expect(done.decisionNote).toBe("Fee was WAIVED, ledger unchanged.");
      expect(await reversalsOf(p.fixture.fee.id)).toHaveLength(0);
    });

    it("a refund that is not in progress cannot be checked (409)", async () => {
      const p = await onlinePayment();
      const requested = await requestedRefund(p);

      await expect(checkRefund(requested.id, admin)).rejects.toMatchObject({
        code: "INVALID_REFUND_STATE",
        statusCode: 409,
      });
    });

    it("404 for an unknown refund", async () => {
      await expect(
        checkRefund("00000000-0000-7000-8000-000000000000", admin),
      ).rejects.toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
    });
  });

  describe("resolveRefund", () => {
    // A refund the gateway answered unclearly, so it waits for a person.
    async function needsReview() {
      const p = await onlinePayment();
      fake.setRefundAnswer({ status: "weird", refundRefId: null, errorReason: null, raw: {} });
      const refund = await createAdminRefund(
        { tranId: p.tranId, reason: "Duplicate charge" },
        admin,
        undefined,
      );
      expect(refund.status).toBe("NEEDS_REVIEW");
      return { p, refund };
    }

    it("SUCCEEDED writes the REVERSAL, stores the reference typed in, and keeps the note", async () => {
      const { p, refund } = await needsReview();

      const done = await resolveRefund(
        refund.id,
        { outcome: "SUCCEEDED", refundRefId: "MANUAL-42", note: "Confirmed in merchant panel" },
        admin,
        "10.0.0.4",
      );

      expect(done).toMatchObject({
        status: "SUCCEEDED",
        refundRefId: "MANUAL-42",
        decisionNote: "Confirmed in merchant panel",
        failureReason: null,
      });
      const reversals = await reversalsOf(p.fixture.fee.id);
      expect(reversals).toHaveLength(1);
      expect(reversals[0]?.reason).toBe("Refund MANUAL-42");
      expect(await actionsOf(refund.id)).toEqual(["refund.create", "refund.resolve"]);
    });

    it("FAILED ends it with the note as the failure reason, and writes no REVERSAL", async () => {
      const { p, refund } = await needsReview();

      const done = await resolveRefund(
        refund.id,
        { outcome: "FAILED", note: "Bank shows no refund" },
        admin,
        undefined,
      );

      expect(done).toMatchObject({ status: "FAILED", failureReason: "Bank shows no refund" });
      expect(done.completedAt).not.toBeNull();
      expect(await reversalsOf(p.fixture.fee.id)).toHaveLength(0);
    });

    it("resolving a refund that is not in review is 409", async () => {
      const p = await onlinePayment();
      const started = await createAdminRefund(
        { tranId: p.tranId, reason: "Duplicate charge" },
        admin,
        undefined,
      );

      await expect(
        resolveRefund(started.id, { outcome: "FAILED", note: "Not yet" }, admin, undefined),
      ).rejects.toMatchObject({ code: "INVALID_REFUND_STATE", statusCode: 409 });
    });

    it("a gateway reference already on another refund is 409", async () => {
      const first = await onlinePayment();
      const earlier = await createAdminRefund(
        { tranId: first.tranId, reason: "Duplicate charge" },
        admin,
        undefined,
      );
      fake.setRefundQuery("RREF-1", refundedAnswer("RREF-1"));
      await checkRefund(earlier.id, admin);

      const { refund } = await needsReview();

      await expect(
        resolveRefund(
          refund.id,
          { outcome: "SUCCEEDED", refundRefId: "RREF-1", note: "Same ref" },
          admin,
          undefined,
        ),
      ).rejects.toMatchObject({ code: "INVALID_REFUND_STATE", statusCode: 409 });
      expect((await getRefund(refund.id)).status).toBe("NEEDS_REVIEW");
    });
  });

  describe("partial refunds", () => {
    it("a second refund takes the rest, a refund above the rest is refused, and then nothing is left", async () => {
      const p = await onlinePayment();
      fake.setRefundAnswer({
        status: "success",
        refundRefId: "RREF-A",
        errorReason: null,
        raw: {},
      });
      const first = await createAdminRefund(
        { tranId: p.tranId, amount: "1000.00", reason: "Half back" },
        admin,
        undefined,
      );
      fake.setRefundQuery("RREF-A", refundedAnswer("RREF-A"));
      await checkRefund(first.id, admin);
      expect((await feeOf(p.fixture.fee.id)).status).toBe("PARTIAL");

      await expect(
        createAdminRefund(
          { tranId: p.tranId, amount: "600.00", reason: "Too much" },
          admin,
          undefined,
        ),
      ).rejects.toMatchObject({
        code: "REFUND_NOT_ALLOWED",
        statusCode: 409,
        message: "Only ৳500.00 is left to refund on this payment.",
      });

      fake.setRefundAnswer({
        status: "success",
        refundRefId: "RREF-B",
        errorReason: null,
        raw: {},
      });
      const second = await createAdminRefund(
        { tranId: p.tranId, reason: "The rest" },
        admin,
        undefined,
      );
      expect(second).toMatchObject({ status: "PROCESSING", amount: "500.00" });
      fake.setRefundQuery("RREF-B", refundedAnswer("RREF-B"));
      await checkRefund(second.id, admin);

      expect((await feeOf(p.fixture.fee.id)).amountPaid.toFixed(2)).toBe("0.00");
      expect(await reversalsOf(p.fixture.fee.id)).toHaveLength(2);
      await expect(
        createAdminRefund({ tranId: p.tranId, reason: "Nothing left" }, admin, undefined),
      ).rejects.toMatchObject({
        code: "REFUND_NOT_ALLOWED",
        statusCode: 409,
        message: "This payment has already been refunded.",
      });
    });

    it("after a refund failed, the whole amount is refundable again", async () => {
      const p = await onlinePayment();
      fake.setRefundAnswer({ status: "failed", refundRefId: null, errorReason: "No", raw: {} });
      const failed = await createAdminRefund(
        { tranId: p.tranId, reason: "First try" },
        admin,
        undefined,
      );
      expect(failed.status).toBe("FAILED");

      fake.setRefundAnswer({
        status: "success",
        refundRefId: "RREF-2",
        errorReason: null,
        raw: {},
      });
      const retry = await createAdminRefund(
        { tranId: p.tranId, reason: "Second try" },
        admin,
        undefined,
      );

      expect(retry).toMatchObject({
        status: "PROCESSING",
        amount: "1500.00",
        refundRefId: "RREF-2",
      });
    });
  });
});
