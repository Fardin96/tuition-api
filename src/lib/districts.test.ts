import { describe, expect, it } from "vitest";
import { DISTRICT_CODES, toDistrictCode } from "./districts.js";

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
