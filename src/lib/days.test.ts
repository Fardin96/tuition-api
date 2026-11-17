import { describe, expect, it } from "vitest";
import { countDays, daysPerWeekFits } from "./days.js";

describe("countDays", () => {
  it("counts the set bits of an availableDays mask", () => {
    expect(countDays(127)).toBe(7);
    expect(countDays(0b0010101)).toBe(3);
    expect(countDays(1)).toBe(1);
  });
});

describe("daysPerWeekFits", () => {
  it("always fits when the count is null or undefined", () => {
    expect(daysPerWeekFits(null, 1)).toBe(true);
    expect(daysPerWeekFits(undefined, 1)).toBe(true);
  });

  it("fits when the count is at most the number of available days", () => {
    expect(daysPerWeekFits(2, 0b0000011)).toBe(true);
    expect(daysPerWeekFits(7, 127)).toBe(true);
  });

  it("does not fit when the count exceeds the number of available days", () => {
    expect(daysPerWeekFits(3, 0b0000011)).toBe(false);
    expect(daysPerWeekFits(4, 0b0010101)).toBe(false);
  });
});
