import { describe, expect, it } from "vitest";
import { createAccount, createArea, createTestApp, getAuthHeaders } from "../../tests/helpers.js";

const URL = "/api/v1/areas";

type Body = {
  divisions: {
    name: string;
    districts: { code: string | null; name: string; areas: { id: number; name: string }[] }[];
  }[];
};

describe("GET /api/v1/areas", () => {
  it("groups active areas by division then district with code, name and id", async () => {
    const app = await createTestApp();
    const agrabad = await createArea({
      division: "Chattogram",
      district: "Chattogram",
      name: "Agrabad",
    });
    const gulshan = await createArea({ division: "Dhaka", district: "Dhaka", name: "Gulshan" });
    const mirpur = await createArea({ division: "Dhaka", district: "Dhaka", name: "Mirpur" });

    const res = await app.inject({ method: "GET", url: URL });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Body;
    expect(body.divisions).toEqual([
      {
        name: "Chattogram",
        districts: [
          {
            code: "chattogram",
            name: "Chattogram",
            areas: [{ id: agrabad.id, name: "Agrabad" }],
          },
        ],
      },
      {
        name: "Dhaka",
        districts: [
          {
            code: "dhaka",
            name: "Dhaka",
            areas: [
              { id: gulshan.id, name: "Gulshan" },
              { id: mirpur.id, name: "Mirpur" },
            ],
          },
        ],
      },
    ]);
  });

  it("sorts divisions, districts and areas by name", async () => {
    const app = await createTestApp();
    await createArea({ division: "Sylhet", district: "Sylhet", name: "Zindabazar" });
    await createArea({ division: "Dhaka", district: "Tangail", name: "Bhuapur" });
    await createArea({ division: "Dhaka", district: "Dhaka", name: "Uttara" });
    await createArea({ division: "Dhaka", district: "Dhaka", name: "Banani" });
    await createArea({ division: "Barishal", district: "Barishal", name: "Kawnia" });

    const res = await app.inject({ method: "GET", url: URL });

    const body = JSON.parse(res.body) as Body;
    expect(body.divisions.map((d) => d.name)).toEqual(["Barishal", "Dhaka", "Sylhet"]);
    const dhaka = body.divisions[1];
    expect(dhaka?.districts.map((d) => d.name)).toEqual(["Dhaka", "Tangail"]);
    expect(dhaka?.districts[0]?.areas.map((a) => a.name)).toEqual(["Banani", "Uttara"]);
  });

  it("leaves out inactive areas", async () => {
    const app = await createTestApp();
    await createArea({ division: "Dhaka", district: "Dhaka", name: "Shown" });
    await createArea({ division: "Dhaka", district: "Dhaka", name: "Hidden", isActive: false });
    await createArea({
      division: "Khulna",
      district: "Khulna",
      name: "Hidden too",
      isActive: false,
    });

    const res = await app.inject({ method: "GET", url: URL });

    const body = JSON.parse(res.body) as Body;
    expect(body.divisions).toHaveLength(1);
    expect(body.divisions[0]?.districts[0]?.areas.map((a) => a.name)).toEqual(["Shown"]);
  });

  it("returns the district code that tutor-city compares against", async () => {
    const app = await createTestApp();
    await createArea({ division: "Dhaka", district: "Dhaka", name: "Mohammadpur" });
    await createArea({ division: "Chattogram", district: "Cox's Bazar", name: "Kolatoli" });

    const res = await app.inject({ method: "GET", url: URL });

    const body = JSON.parse(res.body) as Body;
    const codes = body.divisions.flatMap((d) => d.districts.map((dist) => [dist.name, dist.code]));
    expect(codes).toEqual([
      ["Cox's Bazar", "coxsbazar"],
      ["Dhaka", "dhaka"],
    ]);
  });

  it("gives a null code when the district name is not recognised", async () => {
    const app = await createTestApp();
    await createArea({ division: "Dhaka", district: "Atlantis", name: "Nowhere Town" });

    const res = await app.inject({ method: "GET", url: URL });

    const body = JSON.parse(res.body) as Body;
    expect(body.divisions[0]?.districts[0]).toEqual({
      code: null,
      name: "Atlantis",
      areas: [expect.objectContaining({ name: "Nowhere Town" })],
    });
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
    await createArea({ division: "Dhaka", district: "Dhaka", name: "Dhanmondi" });
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

  it("returns an empty divisions list when there are no areas", async () => {
    const app = await createTestApp();

    const res = await app.inject({ method: "GET", url: URL });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ divisions: [] });
  });
});
