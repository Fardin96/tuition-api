import { Prisma } from "../../generated/prisma/client.js";
import type { FeePromoResponse } from "./fee.schema.js";

export type PromoTerms = {
  discountType: "PERCENT" | "FLAT";
  discountValue: Prisma.Decimal;
  maxDiscount: Prisma.Decimal | null;
};

// What a code takes off a fee. PERCENT is rounded to taka and capped at maxDiscount; FLAT is the
// value. Either way the discount never exceeds the amount due.
export function discountFor(promo: PromoTerms, amountDue: Prisma.Decimal): Prisma.Decimal {
  let discount: Prisma.Decimal;
  if (promo.discountType === "PERCENT") {
    discount = amountDue
      .mul(promo.discountValue)
      .div(100)
      .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
    if (promo.maxDiscount !== null && discount.greaterThan(promo.maxDiscount)) {
      discount = promo.maxDiscount;
    }
  } else {
    discount = promo.discountValue;
  }
  return discount.greaterThan(amountDue) ? amountDue : discount;
}

// Codes are stored and matched uppercase; surrounding spaces are not part of the code.
export function normalizeCode(input: string): string {
  return input.trim().toUpperCase();
}

// The ACTIVE redemption of a fee, as the tutor and admin views show it. Null when there is none.
export function feePromoOf(
  redemption:
    | {
        createdAt: Date;
        originalAmount: Prisma.Decimal;
        discountAmount: Prisma.Decimal;
        promo: { code: string };
      }
    | undefined,
): FeePromoResponse | null {
  if (!redemption) return null;
  return {
    code: redemption.promo.code,
    discountAmount: redemption.discountAmount.toFixed(2),
    originalAmount: redemption.originalAmount.toFixed(2),
    appliedAt: redemption.createdAt,
  };
}
