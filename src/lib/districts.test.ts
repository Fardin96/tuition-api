import { describe, expect, it } from "vitest";
import { DISTRICT_CODES, DISTRICTS, DIVISIONS, toDistrictCode } from "./districts.js";

describe("toDistrictCode", () => {
  it("has the 64 districts of Bangladesh", () => {
    expect(DISTRICT_CODES.size).toBe(64);
  });

  it("normalizes names to canonical slugs", () => {
    expect(toDistrictCode("Dhaka")).toBe("dhaka");
    expect(toDistrictCode("Cox's Bazar")).toBe("coxsbazar");
    expect(toDistrictCode("Chittagong District")).toBe("chattogram");
    expect(toDistrictCode("Comilla")).toBe("cumilla");
    expect(toDistrictCode("Nawabganj")).toBe("chapainawabganj");
    expect(toDistrictCode("Laxmipur")).toBe("lakshmipur");
  });

  it("returns null for unknown names", () => {
    expect(toDistrictCode("")).toBeNull();
    expect(toDistrictCode("Atlantis")).toBeNull();
    expect(toDistrictCode("District")).toBeNull();
  });
});

describe("DISTRICTS", () => {
  it("covers every district code exactly once and round-trips each name", () => {
    expect(Object.keys(DISTRICTS).sort()).toEqual([...DISTRICT_CODES].sort());
    for (const [code, district] of Object.entries(DISTRICTS)) {
      expect(toDistrictCode(district.name)).toBe(code);
      expect(DIVISIONS).toContain(district.division);
    }
  });
});
