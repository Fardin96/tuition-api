import { describe, expect, it } from "vitest";
import { prisma } from "../../lib/prisma.js";
import { createTestApp } from "../../tests/helpers.js";

const URL = "/api/v1/institutions";

type Option = { id: number; name: string; kind: string; matchedAlias: string | null };

async function search(query: string): Promise<{ status: number; names: string[]; rows: Option[] }> {
  const app = await createTestApp();
  const res = await app.inject({ method: "GET", url: `${URL}?${query}` });
  const rows =
    res.statusCode === 200 ? (JSON.parse(res.body) as { institutions: Option[] }).institutions : [];
  return { status: res.statusCode, names: rows.map((r) => r.name), rows };
}

describe("GET /api/v1/institutions", () => {
  it("rejects a one-character query with 400", async () => {
    const { status } = await search("q=d");

    expect(status).toBe(400);
  });

  // Each row: query, the name that must be in the first `within` results, and the reason it matches.
  const cases: [string, string, number][] = [
    ["du", "University of Dhaka", 1], // alias
    ["bracu", "BRAC University", 1], // alias
    ["vnc", "Viqarunnisa Noon School & College", 1], // alias
    ["vnsc", "Viqarunnisa Noon School & College", 1], // alias
    ["dmc", "Dhaka Medical College", 1], // alias
    ["bdc", "Bangladesh Dental College", 1], // alias
    ["ctg", "University of Chittagong", 1], // alias
    ["dhaka uni", "University of Dhaka", 1], // alias prefix
    ["dhaka collage", "Dhaka College", 1], // misspelling, name prefix
    ["rajshahi", "University of Rajshahi", 1], // popularity inside the prefix tier
    ["bm college", "Brajamohan College", 1], // initials-style alias
    ["mc college", "Murari Chand College", 1], // initials-style alias
    ["jagonnath", "Jagannath University", 1], // misspelling
    ["auw", "Asian University for Women", 1], // exact alias beats AUB, which folds the same
    ["ssmc", "Sir Salimullah Medical College", 1], // exact alias beats ShSMC
    ["ddc", "Dhaka Dental College", 1], // exact alias beats folded DC
    ["cuet", "Chittagong University of Engineering & Technology", 1], // alias
    ["chattogram", "Chittagong University of Engineering & Technology", 3], // spelling variant
    ["dhaka unversity", "University of Dhaka", 3], // misspelling: 2nd today
  ];
  it.each(cases)("q=%s puts %s in the first %i", async (q, name, within) => {
    const { names } = await search(`q=${encodeURIComponent(q)}`);

    expect(names.slice(0, within)).toContain(name);
  });

  it("puts University of Chittagong first for ctg", async () => {
    const { names } = await search("q=ctg");

    expect(names[0]).toBe("University of Chittagong");
  });

  it("puts University of Rajshahi first for rajshahi", async () => {
    const { names } = await search("q=rajshahi");

    expect(names[0]).toBe("University of Rajshahi");
  });

  // Two-letter initials are not matched, so a popular row can never be pushed out by a 2-letter collision.
  it("does not match the two-letter initials sa to Shapla Academy", async () => {
    const { names } = await search("q=sa");

    expect(names.slice(0, 5)).not.toContain("Shapla Academy");
  });

  it("finds Rajshahi Medical University through its initials, with matchedAlias null", async () => {
    const { rows } = await search("q=rmu");

    const row = rows.find((r) => r.name === "Rajshahi Medical University");
    expect(row).toBeDefined();
    expect(row?.matchedAlias).toBeNull();
  });

  it("never returns an inactive institution", async () => {
    await prisma.institution.create({
      data: { name: "Zephyrine Test Academy", kind: "SCHOOL", isActive: false },
    });

    const { names } = await search("q=zephyrine%20test");

    expect(names).toEqual([]);
  });

  it("puts a university first for for=tutor and no university in the top 4 for for=student", async () => {
    const tutor = await search("q=dhaka&for=tutor");
    const student = await search("q=dhaka&for=student");

    expect(tutor.names[0]).toBe("University of Dhaka");
    expect(student.rows.slice(0, 4).map((r) => r.name)).not.toContain("University of Dhaka");
  });

  it("ranks schools first for for=student (Notre Dame College is an alias match)", async () => {
    const { names } = await search("q=notre%20dame&for=student");

    expect(names.indexOf("Notre Dame College")).toBeLessThan(
      names.indexOf("Notre Dame University Bangladesh"),
    );
  });

  it("returns at most limit rows", async () => {
    const { rows } = await search("q=dhaka&limit=2");

    expect(rows).toHaveLength(2);
  });
});
