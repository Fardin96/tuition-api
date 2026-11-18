import { Prisma } from "../../generated/prisma/client.js";
import { FeeStatus, PromoRedemptionStatus } from "../../generated/prisma/enums.js";
import { appError, notFound } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { clearPendingAttempt, lockFee } from "../payment/payment.service.js";
import type { TutorFeeDetailResponse } from "./fee.schema.js";
import { getMyFee } from "./fee.service.js";
import { MIN_ONLINE_TOTAL } from "./fee-quote.js";
import { discountFor, normalizeCode } from "./promo.js";

type Tx = Prisma.TransactionClient;

const FEE_NOT_FOUND = "Fee not found";
const CLEAR_REASON = "Replaced by a promo code change";
const ONE_ACTIVE_INDEX = "promo_redemption_one_active_per_fee";
const ALREADY_HAS_CODE = "This fee already has a code. Remove it first.";
const INVALID_CODE = "That code isn't valid.";
const PAYMENT_STARTING =
  "A payment for this fee just started. Finish or cancel it, then try again.";

const feeSelect = {
  tutorId: true,
  status: true,
  amountDue: true,
  amountPaid: true,
} satisfies Prisma.PlatformFeeSelect;

const promoSelect = {
  id: true,
  discountType: true,
  discountValue: true,
  maxDiscount: true,
  startsAt: true,
  endsAt: true,
  maxRedemptions: true,
  maxPerTutor: true,
  isActive: true,
} satisfies Prisma.PromoCodeSelect;

function promoInvalid(message: string) {
  return appError("PromoInvalid", 409, message);
}

function invalidFee(message: string) {
  return appError("InvalidFeeState", 409, message);
}

// Owner only: another tutor's fee is indistinguishable from a missing one.
async function ownFee(accountId: string, feeId: string): Promise<void> {
  const fee = await prisma.platformFee.findFirst({
    where: { id: feeId, tutor: { accountId } },
    select: { id: true },
  });
  if (!fee) throw notFound(FEE_NOT_FOUND);
}

// The second code on a fee hits the one-ACTIVE-per-fee index when two requests race.
function isOneActiveConflict(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return true;
  const text = err instanceof Error ? err.message : "";
  return text.includes(ONE_ACTIVE_INDEX) || text.includes("unique_violation");
}

// Checkout inserts its PENDING attempt under the fee lock, so a checkout that started after
// clearPendingAttempt is visible here. Its amount was quoted before this change, so refuse.
async function refuseIfPaymentStarting(tx: Tx, feeId: string): Promise<void> {
  const pending = await tx.paymentAttempt.findFirst({
    where: { feeId, status: "PENDING" },
    select: { id: true },
  });
  if (pending) throw invalidFee(PAYMENT_STARTING);
}

// Applies a promo code to a DUE fee that has no payment yet. Lock order: fee row, then promo row.
export async function applyPromo(
  accountId: string,
  feeId: string,
  rawCode: string,
): Promise<TutorFeeDetailResponse> {
  await ownFee(accountId, feeId);
  // A PENDING checkout must be settled or ended before the amount it covers can change.
  await clearPendingAttempt(feeId, CLEAR_REASON);
  const code = normalizeCode(rawCode);

  try {
    await prisma.$transaction(async (tx) => {
      await lockFee(tx, feeId);
      const fee = await tx.platformFee.findUnique({ where: { id: feeId }, select: feeSelect });
      if (!fee) throw notFound(FEE_NOT_FOUND);
      await refuseIfPaymentStarting(tx, feeId);
      if (fee.status !== FeeStatus.DUE || !fee.amountPaid.isZero()) {
        throw invalidFee("A code can only be used before any payment is made.");
      }
      const active = await tx.promoRedemption.findFirst({
        where: { feeId, status: PromoRedemptionStatus.ACTIVE },
        select: { id: true },
      });
      if (active) throw invalidFee(ALREADY_HAS_CODE);

      const named = await tx.promoCode.findUnique({ where: { code }, select: { id: true } });
      if (!named) throw promoInvalid(INVALID_CODE);
      // Lock the code, then read it again: the row may have changed while we waited.
      await tx.$queryRaw`SELECT id FROM promo_code WHERE id = ${named.id}::uuid FOR UPDATE`;
      const promo = await tx.promoCode.findUniqueOrThrow({
        where: { id: named.id },
        select: promoSelect,
      });

      if (!promo.isActive) throw promoInvalid(INVALID_CODE);
      const now = new Date();
      if (promo.startsAt && promo.startsAt.getTime() > now.getTime()) {
        throw promoInvalid("That code isn't active yet.");
      }
      if (promo.endsAt && promo.endsAt.getTime() <= now.getTime()) {
        throw promoInvalid("That code has expired.");
      }
      // Counted under the promo lock, so two fees cannot both take the last use.
      const usedTotal = await tx.promoRedemption.count({
        where: { promoId: promo.id, status: PromoRedemptionStatus.ACTIVE },
      });
      if (promo.maxRedemptions !== null && usedTotal >= promo.maxRedemptions) {
        throw promoInvalid("That code has been used up.");
      }
      const usedByTutor = await tx.promoRedemption.count({
        where: { promoId: promo.id, tutorId: fee.tutorId, status: PromoRedemptionStatus.ACTIVE },
      });
      if (usedByTutor >= promo.maxPerTutor) {
        throw promoInvalid("You've already used that code.");
      }

      const discount = discountFor(promo, fee.amountDue);
      if (discount.equals(fee.amountDue)) {
        // The code covers the whole fee: nothing left to pay online or in cash.
        await tx.platformFee.update({ where: { id: feeId }, data: { status: FeeStatus.WAIVED } });
      } else {
        const newDue = fee.amountDue.minus(discount);
        if (newDue.lessThan(MIN_ONLINE_TOTAL)) {
          throw promoInvalid(
            `This code would leave ৳${newDue.toFixed(2)} to pay, below the ৳10 online minimum.`,
          );
        }
        await tx.platformFee.update({
          where: { id: feeId },
          data: { amountDue: newDue.toFixed(2) },
        });
      }

      await tx.promoRedemption.create({
        data: {
          promoId: promo.id,
          feeId,
          tutorId: fee.tutorId,
          originalAmount: fee.amountDue.toFixed(2),
          discountAmount: discount.toFixed(2),
        },
      });
    });
  } catch (err) {
    if (isOneActiveConflict(err)) throw invalidFee(ALREADY_HAS_CODE);
    throw err;
  }

  return getMyFee(accountId, feeId);
}

// Takes the code off a fee that is still DUE and unpaid, and restores the amount it replaced.
export async function removePromo(
  accountId: string,
  feeId: string,
): Promise<TutorFeeDetailResponse> {
  await ownFee(accountId, feeId);
  await clearPendingAttempt(feeId, CLEAR_REASON);

  await prisma.$transaction(async (tx) => {
    await lockFee(tx, feeId);
    const redemption = await tx.promoRedemption.findFirst({
      where: { feeId, status: PromoRedemptionStatus.ACTIVE },
      select: { id: true, originalAmount: true },
    });
    if (!redemption) throw notFound("This fee has no code.");

    const fee = await tx.platformFee.findUnique({ where: { id: feeId }, select: feeSelect });
    if (!fee) throw notFound(FEE_NOT_FOUND);
    await refuseIfPaymentStarting(tx, feeId);
    if (fee.status !== FeeStatus.DUE || !fee.amountPaid.isZero()) {
      throw invalidFee("The code can't be removed after a payment, or from a waived fee.");
    }

    await tx.platformFee.update({
      where: { id: feeId },
      data: { amountDue: redemption.originalAmount.toFixed(2) },
    });
    await tx.promoRedemption.update({
      where: { id: redemption.id },
      data: {
        status: PromoRedemptionStatus.RELEASED,
        releasedAt: new Date(),
        releaseReason: "Removed by tutor",
      },
    });
  });

  return getMyFee(accountId, feeId);
}
