import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { createAccount, createSession, createTestApp, getAuthHeaders } from "./tests/helpers.js";

// A public body well over the 1 KB threshold.
const EDUCATION = "/api/v1/lookups/education";

describe("response compression", () => {
  it("compresses a large public response with brotli when the client accepts it", async () => {
    const app = await createTestApp();
    const identity = await app.inject({ method: "GET", url: EDUCATION });

    const res = await app.inject({
      method: "GET",
      url: EDUCATION,
      headers: { "accept-encoding": "br, gzip" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-encoding"]).toBe("br");
    expect(res.headers.vary).toContain("accept-encoding");
    expect(res.rawPayload.length).toBeLessThan(identity.body.length);
    expect(JSON.parse(zlib.brotliDecompressSync(res.rawPayload).toString("utf8"))).toEqual(
      JSON.parse(identity.body),
    );
  });

  it("falls back to gzip when the client does not accept brotli", async () => {
    const app = await createTestApp();

    const res = await app.inject({
      method: "GET",
      url: EDUCATION,
      headers: { "accept-encoding": "gzip" },
    });

    expect(res.headers["content-encoding"]).toBe("gzip");
    expect(JSON.parse(zlib.gunzipSync(res.rawPayload).toString("utf8")).version).toBe(1);
  });

  it("sends the body as is when the client accepts no encoding", async () => {
    const app = await createTestApp();

    const res = await app.inject({ method: "GET", url: EDUCATION });

    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(JSON.parse(res.body).version).toBe(1);
  });

  it("leaves a body under the 1 KB threshold uncompressed", async () => {
    const app = await createTestApp();
    app.get("/test/small", async () => ({ text: "x".repeat(200) }));

    const res = await app.inject({
      method: "GET",
      url: "/test/small",
      headers: { "accept-encoding": "br, gzip" },
    });

    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(res.body.length).toBeLessThan(1024);
  });

  it("never sends compression on auth routes, even for a body over the threshold", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "STUDENT" });
    for (let i = 0; i < 20; i++) await createSession(account.id);
    const headers = { ...(await getAuthHeaders(account)), "accept-encoding": "br, gzip" };

    const res = await app.inject({ method: "GET", url: "/api/v1/auth/sessions", headers });

    expect(res.statusCode).toBe(200);
    expect(res.body.length).toBeGreaterThan(1024);
    expect(res.headers["content-encoding"]).toBeUndefined();
  });

  it("does not inflate a compressed request body", async () => {
    const app = await createTestApp();
    const body = zlib.gzipSync(JSON.stringify({ refreshToken: "not-a-real-token" }));

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
      body,
    });

    expect(res.statusCode).toBe(400);
  });
});

describe("ETag with compression", () => {
  it("sends a weak ETag on a compressed response", async () => {
    const app = await createTestApp();

    const res = await app.inject({
      method: "GET",
      url: EDUCATION,
      headers: { "accept-encoding": "gzip" },
    });

    expect(res.headers["content-encoding"]).toBe("gzip");
    expect(res.headers.etag).toMatch(/^W\/"/);
  });

  it("answers 304 with no body when if-none-match matches, whatever the encoding asked for", async () => {
    const app = await createTestApp();
    const first = await app.inject({ method: "GET", url: EDUCATION });
    const etag = first.headers.etag as string;
    expect(etag).toMatch(/^W\/"/);

    const res = await app.inject({
      method: "GET",
      url: EDUCATION,
      headers: { "accept-encoding": "br, gzip", "if-none-match": etag },
    });

    expect(res.statusCode).toBe(304);
    expect(res.rawPayload.length).toBe(0);
    expect(res.headers.etag).toBe(etag);
  });
});
