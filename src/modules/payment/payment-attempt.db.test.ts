import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../lib/prisma.js";
import {
  createAccount,
  createApplication,
  createArea,
  createPlatformFee,
  createRequirement,
  createStudentProfile,
  createTutorProfile,
} from "../../tests/helpers.js";

// A confirmed requirement application with a placement fee, set up as in fees.test.ts.
async function setupFee() {
  const area = await createArea();
  const student = await createStudentProfile(
    (await createAccount({ role: "STUDENT" })).id,
    area.id,
  );
  const tutor = await createTutorProfile((await createAccount({ role: "TUTOR" })).id);
  const requirement = await createRequirement({ studentId: student.id });
  const application = await createApplication({
    requirementId: requirement.id,
    tutorId: tutor.id,
    studentId: student.id,
    initiatedBy: "TUTOR",
    status: "CONFIRMED",
  });
  const fee = await createPlatformFee({
    tutorId: tutor.id,
    applicationId: application.id,
    amountDue: 1500,
  });
  return { tutor, fee };
}

function tranId() {
  return `TMT${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

// A valid PENDING attempt for the fee; overrides break one rule at a time.
function attemptData(
  setup: { tutor: { id: string }; fee: { id: string } },
  overrides: Partial<Prisma.PaymentAttemptUncheckedCreateInput> = {},
): Prisma.PaymentAttemptUncheckedCreateInput {
  return {
    feeId: setup.fee.id,
    tutorId: setup.tutor.id,
    tranId: tranId(),
    feeAmount: "1500.00",
    chargeAmount: "0.00",
    totalAmount: "1500.00",
    ...overrides,
  };
}

describe("payment_attempt rules enforced by the database", () => {
  it("rejects a tran_id longer than 30 characters", async () => {
    const setup = await setupFee();

    await expect(
      prisma.paymentAttempt.create({
        data: attemptData(setup, { tranId: "X".repeat(31) }),
      }),
    ).rejects.toThrow(/payment_attempt_tran_id_len/);
  });

  it("rejects a total that is not fee plus charge", async () => {
    const setup = await setupFee();

    await expect(
      prisma.paymentAttempt.create({
        data: attemptData(setup, { chargeAmount: "26.25", totalAmount: "1500.00" }),
      }),
    ).rejects.toThrow(/payment_attempt_total_sum/);
  });

  it("accepts a total equal to fee plus charge", async () => {
    const setup = await setupFee();

    const attempt = await prisma.paymentAttempt.create({
      data: attemptData(setup, { chargeAmount: "26.25", totalAmount: "1526.25" }),
    });

    expect(attempt.status).toBe("PENDING");
    expect(attempt.totalAmount.toFixed(2)).toBe("1526.25");
  });

  it("refuses a second PENDING attempt on one fee", async () => {
    const setup = await setupFee();
    await prisma.paymentAttempt.create({ data: attemptData(setup) });

    await expect(prisma.paymentAttempt.create({ data: attemptData(setup) })).rejects.toThrow(
      /payment_attempt_one_pending_per_fee/,
    );
  });

  it("allows a PENDING attempt next to a FAILED one on the same fee", async () => {
    const setup = await setupFee();
    await prisma.paymentAttempt.create({
      data: attemptData(setup, { status: "FAILED", failureReason: "Card declined" }),
    });

    const pending = await prisma.paymentAttempt.create({ data: attemptData(setup) });

    expect(pending.status).toBe("PENDING");
  });

  it("rejects SUCCEEDED without a payment_id", async () => {
    const setup = await setupFee();

    await expect(
      prisma.paymentAttempt.create({
        data: attemptData(setup, { status: "SUCCEEDED" }),
      }),
    ).rejects.toThrow(/payment_attempt_succeeded_has_payment/);
  });

  it("accepts SUCCEEDED once it points at a ledger row", async () => {
    const setup = await setupFee();
    const payment = await prisma.feePayment.create({
      data: {
        feeId: setup.fee.id,
        amount: 1500,
        method: "SSLCOMMERZ",
        txnReference: tranId(),
        receivedAt: new Date(),
      },
    });

    const attempt = await prisma.paymentAttempt.create({
      data: attemptData(setup, { status: "SUCCEEDED", paymentId: payment.id }),
    });

    expect(attempt.paymentId).toBe(payment.id);
  });
});
