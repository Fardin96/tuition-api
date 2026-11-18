import { randomBytes } from "node:crypto";
import { Prisma } from "../../generated/prisma/client.js";

// SSLCommerz refuses sessions under ৳10.
export const MIN_ONLINE_TOTAL = new Prisma.Decimal("10.00");

export type PaymentSettings = { enabled: boolean; chargePercent: Prisma.Decimal };

export type FeeQuote = {
  feeAmount: Prisma.Decimal;
  chargePercent: Prisma.Decimal;
  chargeAmount: Prisma.Decimal;
  totalAmount: Prisma.Decimal;
};

// The platform does not absorb the gateway's fee: the tutor pays gateway_charge_percent on top.
// The ledger only ever records feeAmount.
export function quoteFor(remaining: Prisma.Decimal, chargePercent: Prisma.Decimal): FeeQuote {
  const chargeAmount = remaining
    .mul(chargePercent)
    .div(100)
    .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  return {
    feeAmount: remaining,
    chargePercent,
    chargeAmount,
    totalAmount: remaining.plus(chargeAmount),
  };
}

// Our merchant transaction id: at most 30 characters for SSLCommerz, [A-Z0-9] only. 22 characters.
export function newTranId(): string {
  const time = Date.now().toString(36).toUpperCase().padStart(8, "0");
  return `TM${time}${randomBytes(6).toString("hex").toUpperCase()}`;
}

// Both keys default when their platform_setting row is missing: payments off, no charge.
export async function readPaymentSettings(db: Prisma.TransactionClient): Promise<PaymentSettings> {
  const rows = await db.platformSetting.findMany({
    where: { key: { in: ["online_payments_enabled", "gateway_charge_percent"] } },
    select: { key: true, value: true },
  });
  const byKey = new Map(rows.map((row) => [row.key, row.value] as const));
  const enabled = byKey.get("online_payments_enabled");
  const percent = byKey.get("gateway_charge_percent");
  return {
    enabled: enabled === true,
    chargePercent: new Prisma.Decimal(typeof percent === "number" ? percent : 0),
  };
}
