import { describe, expect, it } from "vitest";
import { prisma } from "../../lib/prisma.js";
import { createAccount, createTestApp, getAuthHeaders } from "../../tests/helpers.js";

const URL = "/api/v1/subjects";

async function addSubject(data: {
  name: string;
  slug: string;
  sortOrder?: number;
  isActive?: boolean;
}) {
  return prisma.subject.create({ data });
}

describe("GET /api/v1/subjects", () => {
  it("returns active subjects only, sorted by sortOrder then name, with id, name and slug", async () => {
    const app = await createTestApp();
    await addSubject({ name: "Math", slug: "math", sortOrder: 2 });
    await addSubject({ name: "Bangla", slug: "bangla", sortOrder: 1 });
    await addSubject({ name: "Hidden", slug: "hidden", sortOrder: 0, isActive: false });
    await addSubject({ name: "Chemistry", slug: "chemistry", sortOrder: 1 });

    const res = await app.inject({ method: "GET", url: URL });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { subjects: Record<string, unknown>[] };
    expect(body.subjects.map((s) => s.name)).toEqual(["Bangla", "Chemistry", "Math"]);
    expect(Object.keys(body.subjects[0] ?? {}).sort()).toEqual(["id", "name", "slug"]);
  });

  it("sends the public cache-control header to anonymous callers", async () => {
    const app = await createTestApp();

    const res = await app.inject({ method: "GET", url: URL });

    expect(res.headers["cache-control"]).toBe("public, max-age=300, stale-while-revalidate=600");
  });

  it("sends private, no-store to signed-in callers", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "STUDENT" });

    const res = await app.inject({
      method: "GET",
      url: URL,
      headers: await getAuthHeaders(account),
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("private, no-store");
  });

  it("answers 304 when if-none-match matches the etag", async () => {
    const app = await createTestApp();
    await addSubject({ name: "Science", slug: "science" });
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
});
