import { describe, expect, it } from "vitest";
import { createTestApp } from "../../tests/helpers.js";

const URL = "/api/v1/lookups/education";
const EM_NO_GROUPS = ["EM_CAMBRIDGE", "EM_EDEXCEL", "EM_IB", "EM_AMERICAN"];

type Lookup = {
  version: number;
  levelRange: { min: number; max: number };
  curricula: {
    code: string;
    label: string;
    levels: { code: number; label: string }[];
    groups: { code: string; label: string }[];
  }[];
  admissionTargets: { code: string }[];
  retakerLabels: { level: number; label: string }[];
};

describe("GET /api/v1/lookups/education", () => {
  it("returns the education lookup", async () => {
    const app = await createTestApp();
    const res = await app.inject({ method: "GET", url: URL });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Lookup;
    expect(body.version).toBe(1);
    expect(body.levelRange).toEqual({ min: -4, max: 13 });
    expect(body.curricula).toHaveLength(7);
    expect(body.admissionTargets).toHaveLength(10);
    expect(body.retakerLabels).toHaveLength(3);
  });

  it("sends the public cache-control header to anonymous callers", async () => {
    const app = await createTestApp();
    const res = await app.inject({ method: "GET", url: URL });

    expect(res.headers["cache-control"]).toBe("public, max-age=300, stale-while-revalidate=600");
  });

  it("answers 304 when if-none-match matches the etag", async () => {
    const app = await createTestApp();
    const first = await app.inject({ method: "GET", url: URL });
    const etag = first.headers.etag;
    expect(typeof etag).toBe("string");

    const second = await app.inject({
      method: "GET",
      url: URL,
      headers: { "if-none-match": etag as string },
    });
    expect(second.statusCode).toBe(304);
  });

  it("gives every curriculum at least one level, in range and sorted ascending", async () => {
    const app = await createTestApp();
    const res = await app.inject({ method: "GET", url: URL });
    const body = JSON.parse(res.body) as Lookup;

    for (const curriculum of body.curricula) {
      expect(curriculum.levels.length, curriculum.code).toBeGreaterThan(0);
      const codes = curriculum.levels.map((l) => l.code);
      for (const code of codes) {
        expect(code, curriculum.code).toBeGreaterThanOrEqual(-4);
        expect(code, curriculum.code).toBeLessThanOrEqual(13);
      }
      expect(codes, curriculum.code).toEqual([...codes].sort((a, b) => a - b));
    }
  });

  it("gives the English and IB curricula no academic groups", async () => {
    const app = await createTestApp();
    const res = await app.inject({ method: "GET", url: URL });
    const body = JSON.parse(res.body) as Lookup;

    for (const code of EM_NO_GROUPS) {
      const curriculum = body.curricula.find((c) => c.code === code);
      expect(curriculum, code).toBeDefined();
      expect(curriculum?.groups, code).toEqual([]);
    }
  });

  it("labels the Madrasah HUMANITIES group as General", async () => {
    const app = await createTestApp();
    const res = await app.inject({ method: "GET", url: URL });
    const body = JSON.parse(res.body) as Lookup;

    const madrasah = body.curricula.find((c) => c.code === "MADRASAH");
    const humanities = madrasah?.groups.find((g) => g.code === "HUMANITIES");
    expect(humanities?.label).toBe("General");
  });
});
