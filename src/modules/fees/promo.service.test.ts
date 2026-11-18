import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import { setPaymentGatewayForTests } from "../../lib/sslcommerz.js";
import {
  createAccount,
  createFakeGateway,
  createFeePayment,
  createPlatformFee,
  createSuperAdmin,
  createTestApp,
  createTutorFeeFixture,
  createTutorProfile,
  getAuthHeaders,
  setPlatformSetting,
} from "../../tests/helpers.js";

// Lets one test skip the pre-transaction clearPendingAttempt, so the in-transaction guard is the
// only thing that can refuse. ESM named exports cannot be spied on, so the module is mocked and
// delegates to the real function unless the flag is set.
const pendingGuard = vi.hoisted(() => ({ skipClear: false }));

vi.mock("../payment/payment.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../payment/payment.service.js")>();
  return {
    ...actual,
    clearPendingAttempt: async (feeId: string, reason: string) => {
      if (pendingGuard.skipClear) return;
      return actual.clearPendingAttempt(feeId, reason);
    },
  };
});

const FEES_URL = "/api/v1/fees";
const DAY_MS = 24 * 60 * 60 * 1000;

const ENV_KEYS = [
  "SSLC_STORE_ID",
  "SSLC_STORE_PASSWORD",
  "API_PUBLIC_URL",
  "WEB_PUBLIC_URL",
] as const;
let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
let fake: ReturnType<typeof createFakeGateway>;

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, env[key]]));
  env.SSLC_STORE_ID = "teststore";
  env.SSLC_STORE_PASSWORD = "testpass";
  env.API_PUBLIC_URL = "http://api.test";
  env.WEB_PUBLIC_URL = "http://web.test";
  fake = createFakeGateway();
  setPaymentGatewayForTests(fake.gateway);
  await setPlatformSetting("online_payments_enabled", true);
  await setPlatformSetting("gateway_charge_percent", 2.5);
});

afterEach(() => {
  setPaymentGatewayForTests(null);
  for (const key of ENV_KEYS) env[key] = savedEnv[key];
});

type PromoOverrides = {
  code: string;
  discountType?: "PERCENT" | "FLAT";
  discountValue?: number;
  maxDiscount?: number | null;
  startsAt?: Date | null;
  endsAt?: Date | null;
  maxRedemptions?: number | null;
  maxPerTutor?: number;
  isActive?: boolean;
};

async function makePromo(overrides: PromoOverrides) {
  const admin = await createSuperAdmin();
  return prisma.promoCode.create({
    data: {
      code: overrides.code,
      discountType: overrides.discountType ?? "PERCENT",
      discountValue: overrides.discountValue ?? 10,
      maxDiscount: overrides.maxDiscount ?? null,
      startsAt: overrides.startsAt ?? null,
      endsAt: overrides.endsAt ?? null,
      maxRedemptions: overrides.maxRedemptions ?? null,
      maxPerTutor: overrides.maxPerTutor ?? 1,
      isActive: overrides.isActive ?? true,
      createdById: admin.id,
    },
  });
}

type App = Awaited<ReturnType<typeof createTestApp>>;
type Headers = Record<string, string>;

function applyCode(app: App, feeId: string, code: string, headers: Headers) {
  return app.inject({
    method: "POST",
    url: `${FEES_URL}/${feeId}/promo`,
    headers,
    payload: { code },
  });
}

function removeCode(app: App, feeId: string, headers: Headers) {
  return app.inject({ method: "DELETE", url: `${FEES_URL}/${feeId}/promo`, headers });
}

async function redemptionsOf(feeId: string) {
  return prisma.promoRedemption.findMany({ where: { feeId }, orderBy: { createdAt: "asc" } });
}

describe("promo codes on a tutor's fee", () => {
  describe("POST /api/v1/fees/:id/promo", () => {
    it("a percentage code lowers the amount due, and the checkout quote follows it", async () => {
      const app = await createTestApp();
      const setup = await createTutorFeeFixture(1500);
      await makePromo({ code: "SAVE10", discountValue: 10 });

      // The code is matched case-insensitively and surrounding spaces are ignored.
      const res = await applyCode(app, setup.fee.id, " save10 ", setup.tutorHeaders);

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toMatchObject({
        status: "DUE",
        amountDue: "1350.00",
        amountPaid: "0.00",
        remaining: "1350.00",
        promoAllowed: false,
        promo: { code: "SAVE10", discountAmount: "150.00", originalAmount: "1500.00" },
        checkout: { feeAmount: "1350.00", chargeAmount: "33.75", totalAmount: "1383.75" },
      });

      const fee = await prisma.platformFee.findUniqueOrThrow({ where: { id: setup.fee.id } });
      expect(fee.amountDue.toFixed(2)).toBe("1350.00");
      expect(fee.amountPaid.toFixed(2)).toBe("0.00");
      const [redemption] = await redemptionsOf(setup.fee.id);
      expect(redemption).toMatchObject({ status: "ACTIVE", releasedAt: null });
      expect(redemption.discountAmount.toFixed(2)).toBe("150.00");
      expect(redemption.originalAmount.toFixed(2)).toBe("1500.00");
    });

    it("caps a percentage discount at the code's maximum", async () => {
      const app = await createTestApp();
      const setup = await createTutorFeeFixture(1500);
      await makePromo({ code: "HALFOFF", discountValue: 50, maxDiscount: 100 });

      const res = await applyCode(app, setup.fee.id, "HALFOFF", setup.tutorHeaders);

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({
        amountDue: "1400.00",
        promo: { discountAmount: "100.00", originalAmount: "1500.00" },
      });
    });

    it("a flat code takes its value off the amount due", async () => {
      const app = await createTestApp();
      const setup = await createTutorFeeFixture(1500);
      await makePromo({ code: "FLAT250", discountType: "FLAT", discountValue: 250 });

      const res = await applyCode(app, setup.fee.id, "FLAT250", setup.tutorHeaders);

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({
        status: "DUE",
        amountDue: "1250.00",
        promo: { code: "FLAT250", discountAmount: "250.00" },
      });
    });

    it("a 100% code waives the fee: nothing to pay, no checkout, the promo is shown", async () => {
      const app = await createTestApp();
      const setup = await createTutorFeeFixture(1500);
      await makePromo({ code: "FREE", discountValue: 100 });

      const res = await applyCode(app, setup.fee.id, "FREE", setup.tutorHeaders);

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({
        status: "WAIVED",
        amountDue: "1500.00",
        remaining: "1500.00",
        checkout: null,
        promoAllowed: false,
        promo: { code: "FREE", discountAmount: "1500.00", originalAmount: "1500.00" },
      });
      const fee = await prisma.platformFee.findUniqueOrThrow({ where: { id: setup.fee.id } });
      expect(fee.status).toBe("WAIVED");
      expect(fee.amountDue.toFixed(2)).toBe("1500.00");
    });

    it("a flat code larger than the fee waives it, with the discount capped at the fee", async () => {
      const app = await createTestApp();
      const setup = await createTutorFeeFixture(1500);
      await makePromo({ code: "BIGFLAT", discountType: "FLAT", discountValue: 2000 });

      const res = await applyCode(app, setup.fee.id, "BIGFLAT", setup.tutorHeaders);

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({
        status: "WAIVED",
        amountDue: "1500.00",
        promo: { discountAmount: "1500.00" },
      });
    });

    it("refuses a code that would leave less than ৳10 to pay, and changes nothing", async () => {
      const app = await createTestApp();
      const setup = await createTutorFeeFixture(1500);
      await makePromo({ code: "ALMOST", discountType: "FLAT", discountValue: 1495 });

      const res = await applyCode(app, setup.fee.id, "ALMOST", setup.tutorHeaders);

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body)).toMatchObject({
        code: "PROMO_INVALID",
        message: "This code would leave ৳5.00 to pay, below the ৳10 online minimum.",
      });
      const fee = await prisma.platformFee.findUniqueOrThrow({ where: { id: setup.fee.id } });
      expect(fee.status).toBe("DUE");
      expect(fee.amountDue.toFixed(2)).toBe("1500.00");
      expect(await redemptionsOf(setup.fee.id)).toHaveLength(0);
    });

    it("allows a code that leaves exactly ৳10 to pay", async () => {
      const app = await createTestApp();
      const setup = await createTutorFeeFixture(1500);
      await makePromo({ code: "TENLEFT", discountType: "FLAT", discountValue: 1490 });

      const res = await applyCode(app, setup.fee.id, "TENLEFT", setup.tutorHeaders);

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({ amountDue: "10.00", status: "DUE" });
    });

    it.each([
      {
        name: "an unknown code",
        code: "NOPE1",
        promo: null,
        message: "That code isn't valid.",
      },
      {
        name: "an inactive code",
        code: "OFF1",
        promo: { code: "OFF1", isActive: false },
        message: "That code isn't valid.",
      },
      {
        name: "a code that has not started",
        code: "SOON",
        promo: { code: "SOON", startsAt: new Date(Date.now() + DAY_MS) },
        message: "That code isn't active yet.",
      },
      {
        name: "an expired code",
        code: "OLD",
        promo: { code: "OLD", endsAt: new Date(Date.now() - DAY_MS) },
        message: "That code has expired.",
      },
    ])("refuses $name with 409 PROMO_INVALID", async ({ code, promo, message }) => {
      const app = await createTestApp();
      const setup = await createTutorFeeFixture(1500);
      if (promo) await makePromo(promo);

      const res = await applyCode(app, setup.fee.id, code, setup.tutorHeaders);

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body)).toMatchObject({ code: "PROMO_INVALID", message });
      const fee = await prisma.platformFee.findUniqueOrThrow({ where: { id: setup.fee.id } });
      expect(fee.amountDue.toFixed(2)).toBe("1500.00");
      expect(await redemptionsOf(setup.fee.id)).toHaveLength(0);
    });

    it("refuses a code that has been used up across all tutors", async () => {
      const app = await createTestApp();
      await makePromo({ code: "ONCE", maxRedemptions: 1 });
      const first = await createTutorFeeFixture(1500);
      expect((await applyCode(app, first.fee.id, "ONCE", first.tutorHeaders)).statusCode).toBe(200);

      const second = await createTutorFeeFixture(1500);
      const res = await applyCode(app, second.fee.id, "ONCE", second.tutorHeaders);

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body)).toMatchObject({
        code: "PROMO_INVALID",
        message: "That code has been used up.",
      });
    });

    it("refuses a second use of a code by the same tutor on another fee", async () => {
      const app = await createTestApp();
      await makePromo({ code: "TWICE", maxPerTutor: 1 });
      const setup = await createTutorFeeFixture(1500);
      const other = await createPlatformFee({
        tutorId: setup.tutor.id,
        applicationId: setup.application.id,
        feeType: "OTHER",
        amountDue: 1000,
      });
      expect((await applyCode(app, setup.fee.id, "TWICE", setup.tutorHeaders)).statusCode).toBe(
        200,
      );

      const res = await applyCode(app, other.id, "TWICE", setup.tutorHeaders);

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body)).toMatchObject({
        code: "PROMO_INVALID",
        message: "You've already used that code.",
      });
    });

    it("allows a second use by the same tutor when maxPerTutor is 2", async () => {
      const app = await createTestApp();
      await makePromo({ code: "TWICEOK", maxPerTutor: 2 });
      const setup = await createTutorFeeFixture(1500);
      const other = await createPlatformFee({
        tutorId: setup.tutor.id,
        applicationId: setup.application.id,
        feeType: "OTHER",
        amountDue: 1000,
      });
      expect((await applyCode(app, setup.fee.id, "TWICEOK", setup.tutorHeaders)).statusCode).toBe(
        200,
      );

      const res = await applyCode(app, other.id, "TWICEOK", setup.tutorHeaders);

      expect(res.statusCode).toBe(200);
    });

    it("refuses a fee that already has a payment, with 409 INVALID_FEE_STATE", async () => {
      const app = await createTestApp();
      const admin = await createSuperAdmin();
      await makePromo({ code: "SAVE10" });
      const setup = await createTutorFeeFixture(1500);
      await createFeePayment({ feeId: setup.fee.id, amount: 500, recordedById: admin.id });

      const res = await applyCode(app, setup.fee.id, "SAVE10", setup.tutorHeaders);

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body)).toMatchObject({
        code: "INVALID_FEE_STATE",
        message: "A code can only be used before any payment is made.",
      });
      const fee = await prisma.platformFee.findUniqueOrThrow({ where: { id: setup.fee.id } });
      expect(fee.amountDue.toFixed(2)).toBe("1500.00");
    });

    it("refuses a second code on the same fee, with 409 INVALID_FEE_STATE", async () => {
      const app = await createTestApp();
      await makePromo({ code: "SAVE10" });
      await makePromo({ code: "SAVE20", discountValue: 20 });
      const setup = await createTutorFeeFixture(1500);
      expect((await applyCode(app, setup.fee.id, "SAVE10", setup.tutorHeaders)).statusCode).toBe(
        200,
      );

      const res = await applyCode(app, setup.fee.id, "SAVE20", setup.tutorHeaders);

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body)).toMatchObject({
        code: "INVALID_FEE_STATE",
        message: "This fee already has a code. Remove it first.",
      });
      const fee = await prisma.platformFee.findUniqueOrThrow({ where: { id: setup.fee.id } });
      expect(fee.amountDue.toFixed(2)).toBe("1350.00");
    });

    it("ends a PENDING checkout first, so the tutor pays the new amount", async () => {
      const app = await createTestApp();
      await makePromo({ code: "SAVE10" });
      const setup = await createTutorFeeFixture(1500);
      const checkout = await app.inject({
        method: "POST",
        url: `${FEES_URL}/${setup.fee.id}/checkout`,
        headers: setup.tutorHeaders,
      });
      expect(checkout.statusCode).toBe(201);
      const { tranId } = JSON.parse(checkout.body);

      const res = await applyCode(app, setup.fee.id, "SAVE10", setup.tutorHeaders);

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({ amountDue: "1350.00", pendingAttempt: null });
      const attempt = await prisma.paymentAttempt.findUniqueOrThrow({ where: { tranId } });
      expect(attempt.status).toBe("EXPIRED");
      expect(attempt.failureReason).toBe("Replaced by a promo code change");
    });

    it("returns 404 for a fee of another tutor and applies nothing", async () => {
      const app = await createTestApp();
      await makePromo({ code: "SAVE10" });
      const setup = await createTutorFeeFixture(1500);
      const other = await createAccount({ role: "TUTOR" });
      await createTutorProfile(other.id);

      const res = await applyCode(app, setup.fee.id, "SAVE10", await getAuthHeaders(other));

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).message).toBe("Fee not found");
      expect(await redemptionsOf(setup.fee.id)).toHaveLength(0);
    });

    it("gives a student 403", async () => {
      const app = await createTestApp();
      await makePromo({ code: "SAVE10" });
      const setup = await createTutorFeeFixture(1500);
      const student = await createAccount({ role: "STUDENT" });

      const res = await applyCode(app, setup.fee.id, "SAVE10", await getAuthHeaders(student));

      expect(res.statusCode).toBe(403);
    });
  });

  describe("DELETE /api/v1/fees/:id/promo", () => {
    it("restores the amount due, releases the redemption, and the code can be used again", async () => {
      const app = await createTestApp();
      await makePromo({ code: "SAVE10" });
      const setup = await createTutorFeeFixture(1500);
      expect((await applyCode(app, setup.fee.id, "SAVE10", setup.tutorHeaders)).statusCode).toBe(
        200,
      );

      const res = await removeCode(app, setup.fee.id, setup.tutorHeaders);

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({
        status: "DUE",
        amountDue: "1500.00",
        promo: null,
        promoAllowed: true,
        checkout: { feeAmount: "1500.00" },
      });
      const [redemption] = await redemptionsOf(setup.fee.id);
      expect(redemption).toMatchObject({
        status: "RELEASED",
        releaseReason: "Removed by tutor",
      });
      expect(redemption.releasedAt).toBeInstanceOf(Date);

      const again = await applyCode(app, setup.fee.id, "SAVE10", setup.tutorHeaders);
      expect(again.statusCode).toBe(200);
      expect(JSON.parse(again.body)).toMatchObject({ amountDue: "1350.00" });
      expect(await redemptionsOf(setup.fee.id)).toHaveLength(2);
    });

    it("refuses to remove a code from a waived fee, with 409 INVALID_FEE_STATE", async () => {
      const app = await createTestApp();
      await makePromo({ code: "FREE", discountValue: 100 });
      const setup = await createTutorFeeFixture(1500);
      expect((await applyCode(app, setup.fee.id, "FREE", setup.tutorHeaders)).statusCode).toBe(200);

      const res = await removeCode(app, setup.fee.id, setup.tutorHeaders);

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body)).toMatchObject({
        code: "INVALID_FEE_STATE",
        message: "The code can't be removed after a payment, or from a waived fee.",
      });
      const fee = await prisma.platformFee.findUniqueOrThrow({ where: { id: setup.fee.id } });
      expect(fee.status).toBe("WAIVED");
    });

    it("refuses to remove a code once the fee has a payment", async () => {
      const app = await createTestApp();
      const admin = await createSuperAdmin();
      await makePromo({ code: "SAVE10" });
      const setup = await createTutorFeeFixture(1500);
      expect((await applyCode(app, setup.fee.id, "SAVE10", setup.tutorHeaders)).statusCode).toBe(
        200,
      );
      await createFeePayment({ feeId: setup.fee.id, amount: 100, recordedById: admin.id });

      const res = await removeCode(app, setup.fee.id, setup.tutorHeaders);

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).code).toBe("INVALID_FEE_STATE");
    });

    it("returns 404 when the fee has no code", async () => {
      const app = await createTestApp();
      const setup = await createTutorFeeFixture(1500);

      const res = await removeCode(app, setup.fee.id, setup.tutorHeaders);

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).message).toBe("This fee has no code.");
    });

    it("returns 404 for a fee of another tutor and removes nothing", async () => {
      const app = await createTestApp();
      await makePromo({ code: "SAVE10" });
      const setup = await createTutorFeeFixture(1500);
      expect((await applyCode(app, setup.fee.id, "SAVE10", setup.tutorHeaders)).statusCode).toBe(
        200,
      );
      const other = await createAccount({ role: "TUTOR" });
      await createTutorProfile(other.id);

      const res = await removeCode(app, setup.fee.id, await getAuthHeaders(other));

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).message).toBe("Fee not found");
      const fee = await prisma.platformFee.findUniqueOrThrow({ where: { id: setup.fee.id } });
      expect(fee.amountDue.toFixed(2)).toBe("1350.00");
    });
  });

  describe("a payment starting while the code changes", () => {
    const STARTING = "A payment for this fee just started. Finish or cancel it, then try again.";

    // A checkout that committed after clearPendingAttempt ran, quoting the old amount.
    async function insertPendingAttempt(
      setup: Awaited<ReturnType<typeof createTutorFeeFixture>>,
      tranId: string,
    ) {
      return prisma.paymentAttempt.create({
        data: {
          feeId: setup.fee.id,
          tutorId: setup.tutor.id,
          tranId,
          feeAmount: "1500.00",
          chargeAmount: "0.00",
          totalAmount: "1500.00",
        },
      });
    }

    it("the clear alone would end the attempt and let the apply through", async () => {
      // Baseline: with the pre-transaction clear working, the default fake gateway (no payment
      // found) ends the PENDING attempt and the apply succeeds.
      const app = await createTestApp();
      await makePromo({ code: "SAVE10" });
      const setup = await createTutorFeeFixture(1500);
      await insertPendingAttempt(setup, "BASELINE01");

      const res = await applyCode(app, setup.fee.id, "SAVE10", setup.tutorHeaders);

      expect(res.statusCode).toBe(200);
      const attempt = await prisma.paymentAttempt.findUniqueOrThrow({
        where: { tranId: "BASELINE01" },
      });
      expect(attempt.status).toBe("EXPIRED");
    });

    it("apply refuses with 409 when a PENDING attempt appears after the clear", async () => {
      const app = await createTestApp();
      await makePromo({ code: "SAVE10" });
      const setup = await createTutorFeeFixture(1500);
      await insertPendingAttempt(setup, "STARTING01");

      pendingGuard.skipClear = true;
      let res: Awaited<ReturnType<typeof applyCode>>;
      try {
        res = await applyCode(app, setup.fee.id, "SAVE10", setup.tutorHeaders);
      } finally {
        pendingGuard.skipClear = false;
      }

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body)).toMatchObject({ code: "INVALID_FEE_STATE", message: STARTING });
      const fee = await prisma.platformFee.findUniqueOrThrow({ where: { id: setup.fee.id } });
      expect(fee.amountDue.toFixed(2)).toBe("1500.00");
      expect(await redemptionsOf(setup.fee.id)).toHaveLength(0);
      const attempt = await prisma.paymentAttempt.findUniqueOrThrow({
        where: { tranId: "STARTING01" },
      });
      expect(attempt.status).toBe("PENDING");
    });

    it("remove refuses with 409 when a PENDING attempt appears after the clear", async () => {
      const app = await createTestApp();
      await makePromo({ code: "SAVE10" });
      const setup = await createTutorFeeFixture(1500);
      expect((await applyCode(app, setup.fee.id, "SAVE10", setup.tutorHeaders)).statusCode).toBe(
        200,
      );
      await insertPendingAttempt(setup, "STARTING02");

      pendingGuard.skipClear = true;
      let res: Awaited<ReturnType<typeof removeCode>>;
      try {
        res = await removeCode(app, setup.fee.id, setup.tutorHeaders);
      } finally {
        pendingGuard.skipClear = false;
      }

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body)).toMatchObject({ code: "INVALID_FEE_STATE", message: STARTING });
      const fee = await prisma.platformFee.findUniqueOrThrow({ where: { id: setup.fee.id } });
      expect(fee.amountDue.toFixed(2)).toBe("1350.00");
      const [redemption] = await redemptionsOf(setup.fee.id);
      expect(redemption.status).toBe("ACTIVE");
    });
  });

  describe("concurrency and fee lifecycle", () => {
    it("two tutors racing for the last use of a code: exactly one succeeds", async () => {
      const app = await createTestApp();
      await makePromo({ code: "LASTONE", maxRedemptions: 1 });
      const a = await createTutorFeeFixture(1500);
      const b = await createTutorFeeFixture(1500);

      const [resA, resB] = await Promise.all([
        applyCode(app, a.fee.id, "LASTONE", a.tutorHeaders),
        applyCode(app, b.fee.id, "LASTONE", b.tutorHeaders),
      ]);

      expect([resA.statusCode, resB.statusCode].sort()).toEqual([200, 409]);
      const loser = resA.statusCode === 409 ? resA : resB;
      expect(JSON.parse(loser.body)).toMatchObject({
        code: "PROMO_INVALID",
        message: "That code has been used up.",
      });
      expect(await prisma.promoRedemption.count({ where: { status: "ACTIVE" } })).toBe(1);
    });

    it("voiding the fee releases its code, so the code is free for another tutor", async () => {
      const app = await createTestApp();
      await makePromo({ code: "VOIDME", maxRedemptions: 1 });
      const first = await createTutorFeeFixture(1500);
      expect((await applyCode(app, first.fee.id, "VOIDME", first.tutorHeaders)).statusCode).toBe(
        200,
      );

      await prisma.platformFee.update({ where: { id: first.fee.id }, data: { status: "VOID" } });

      const [redemption] = await redemptionsOf(first.fee.id);
      expect(redemption).toMatchObject({ status: "RELEASED", releaseReason: "Fee voided" });
      expect(redemption.releasedAt).toBeInstanceOf(Date);

      const second = await createTutorFeeFixture(1500);
      const res = await applyCode(app, second.fee.id, "VOIDME", second.tutorHeaders);
      expect(res.statusCode).toBe(200);
    });
  });
});
