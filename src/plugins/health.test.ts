import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../lib/prisma.js";
import { createTestApp } from "../tests/helpers.js";

describe("GET /api/v1/health", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns ok and is never cached", async () => {
    const app = await createTestApp();

    const res = await app.inject({ method: "GET", url: "/api/v1/health" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(JSON.parse(res.body)).toMatchObject({ status: "ok", db: "ok" });
  });

  it("returns 503 when the database is unreachable", async () => {
    const app = await createTestApp();
    vi.spyOn(prisma, "$queryRaw").mockRejectedValueOnce(new Error("db down"));

    const res = await app.inject({ method: "GET", url: "/api/v1/health" });

    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toMatchObject({ status: "degraded", db: "unavailable" });
  });
});
