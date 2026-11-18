import { describe, expect, it } from "vitest";
import { Prisma } from "../../generated/prisma/client.js";
import { discountFor, normalizeCode } from "./promo.js";

const d = (value: string) => new Prisma.Decimal(value);

describe("discountFor", () => {
  it("takes a percentage of the amount due", () => {
    expect(
      discountFor(
        { discountType: "PERCENT", discountValue: d("10"), maxDiscount: null },
        d("1500"),
      ).toFixed(2),
    ).toBe("150.00");
  });

  it("rounds the percentage half up to 2 decimal places", () => {
    // 10.10 * 25% = 2.525, which rounds up to 2.53 (not down to 2.52).
    expect(
      discountFor(
        { discountType: "PERCENT", discountValue: d("25"), maxDiscount: null },
        d("10.10"),
      ).toFixed(2),
    ).toBe("2.53");
    // 333.33 * 15% = 49.9995, which rounds up to 50.00.
    expect(
      discountFor(
        { discountType: "PERCENT", discountValue: d("15"), maxDiscount: null },
        d("333.33"),
      ).toFixed(2),
    ).toBe("50.00");
  });

  it("caps a percentage discount at maxDiscount", () => {
    expect(
      discountFor(
        { discountType: "PERCENT", discountValue: d("50"), maxDiscount: d("100") },
        d("1500"),
      ).toFixed(2),
    ).toBe("100.00");
  });

  it("does not change a percentage discount below its cap", () => {
    expect(
      discountFor(
        { discountType: "PERCENT", discountValue: d("10"), maxDiscount: d("500") },
        d("1500"),
      ).toFixed(2),
    ).toBe("150.00");
  });

  it("takes the flat value", () => {
    expect(
      discountFor(
        { discountType: "FLAT", discountValue: d("250"), maxDiscount: null },
        d("1500"),
      ).toFixed(2),
    ).toBe("250.00");
  });

  it("ignores maxDiscount for a flat code", () => {
    expect(
      discountFor(
        { discountType: "FLAT", discountValue: d("250"), maxDiscount: d("100") },
        d("1500"),
      ).toFixed(2),
    ).toBe("250.00");
  });

  it("never takes more than the amount due, for a flat code", () => {
    expect(
      discountFor(
        { discountType: "FLAT", discountValue: d("2000"), maxDiscount: null },
        d("1500"),
      ).toFixed(2),
    ).toBe("1500.00");
  });

  it("takes the whole amount for a 100% code", () => {
    expect(
      discountFor(
        { discountType: "PERCENT", discountValue: d("100"), maxDiscount: null },
        d("1500"),
      ).toFixed(2),
    ).toBe("1500.00");
  });
});

describe("normalizeCode", () => {
  it("trims and uppercases", () => {
    expect(normalizeCode("  save10 ")).toBe("SAVE10");
  });
});
