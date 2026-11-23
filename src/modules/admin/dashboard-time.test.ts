import { describe, expect, it } from "vitest";
import { bucketKeys, rangeWindows } from "./dashboard-time.js";

// 15 Dec 2026, 12:00 in Dhaka.
const NOW = new Date("2026-12-15T06:00:00Z");

describe("rangeWindows", () => {
  it("all: runs from the Dhaka month of since, in month buckets, with an empty previous window", () => {
    // 10 Jun 2025 in Dhaka. The 12m start (Jan 2026) is later, so the start is June 2025.
    const w = rangeWindows("all", NOW, new Date("2025-06-10T06:00:00Z"));

    expect(w.start).toEqual(new Date("2025-05-31T18:00:00Z")); // 1 Jun 2025, Dhaka midnight
    expect(w.end).toEqual(NOW);
    expect(w.bucket).toBe("month");
    expect(w.prevStart).toEqual(w.start);
    expect(w.prevEnd).toEqual(w.start);
    const keys = bucketKeys(w);
    expect(keys[0]).toBe("2025-06-01");
    expect(keys.at(-1)).toBe("2026-12-01");
    expect(keys).toHaveLength(19);
  });

  it("all: uses the Dhaka month, so 19:00 UTC on 31 May is 1 June in Dhaka", () => {
    const w = rangeWindows("all", NOW, new Date("2025-05-31T19:00:00Z"));
    expect(bucketKeys(w)[0]).toBe("2025-06-01");
  });

  it("all without since falls back to the 12m start", () => {
    const all = rangeWindows("all", NOW);
    const twelve = rangeWindows("12m", NOW);
    expect(all.start).toEqual(twelve.start);
    expect(bucketKeys(all)).toHaveLength(12);
    expect(bucketKeys(all)[0]).toBe("2026-01-01");
    expect(all.prevStart).toEqual(all.start);
    expect(all.prevEnd).toEqual(all.start);
  });

  it("all: a since later than the 12m start falls back to the 12m start", () => {
    const w = rangeWindows("all", NOW, new Date("2026-03-04T06:00:00Z"));
    expect(w.start).toEqual(rangeWindows("12m", NOW).start);
    expect(bucketKeys(w)[0]).toBe("2026-01-01");
  });

  it("12m and day ranges ignore since", () => {
    const since = new Date("2025-01-01T00:00:00Z");
    expect(rangeWindows("12m", NOW, since)).toEqual(rangeWindows("12m", NOW));
    expect(rangeWindows("30d", NOW, since)).toEqual(rangeWindows("30d", NOW));
  });
});
