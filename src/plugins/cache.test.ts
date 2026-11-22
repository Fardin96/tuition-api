import { describe, expect, it } from "vitest";
import { createAccount, createTestApp, getAuthHeaders } from "../tests/helpers.js";
import { publicCache, sharedCache } from "./cache.js";

// Routes that exercise the helpers directly, so the header rules are tested without a domain route.
async function appWithCacheRoutes() {
  const app = await createTestApp();
  app.get("/test/shared", async (request, reply) => {
    sharedCache(request, reply, 60);
    return { ok: true };
  });
  app.get("/test/public", async (request, reply) => {
    publicCache(request, reply, "public, max-age=60, stale-while-revalidate=120");
    return { ok: true };
  });
  return app;
}

describe("sharedCache", () => {
  it("lets anonymous callers share the body, with stale-while-revalidate of twice the age", async () => {
    const app = await appWithCacheRoutes();

    const res = await app.inject({ method: "GET", url: "/test/shared" });

    expect(res.headers["cache-control"]).toBe("public, max-age=60, stale-while-revalidate=120");
    expect(res.headers.vary).toBe("Authorization");
  });

  it("keeps a signed-in caller's copy in the browser only", async () => {
    const app = await appWithCacheRoutes();
    const account = await createAccount({ role: "STUDENT" });

    const res = await app.inject({
      method: "GET",
      url: "/test/shared",
      headers: await getAuthHeaders(account),
    });

    expect(res.headers["cache-control"]).toBe("private, max-age=60");
    expect(res.headers["cache-control"]).not.toContain("public");
    expect(res.headers.vary).toBe("Authorization");
  });

  it("treats a request with an invalid token as anonymous", async () => {
    const app = await appWithCacheRoutes();

    const res = await app.inject({
      method: "GET",
      url: "/test/shared",
      headers: { authorization: "Bearer not-a-real-token" },
    });

    expect(res.headers["cache-control"]).toBe("public, max-age=60, stale-while-revalidate=120");
  });
});

describe("publicCache", () => {
  it("still sends private, no-store to signed-in callers", async () => {
    const app = await appWithCacheRoutes();
    const account = await createAccount({ role: "STUDENT" });

    const anonymous = await app.inject({ method: "GET", url: "/test/public" });
    const signedIn = await app.inject({
      method: "GET",
      url: "/test/public",
      headers: await getAuthHeaders(account),
    });

    expect(anonymous.headers["cache-control"]).toBe(
      "public, max-age=60, stale-while-revalidate=120",
    );
    expect(signedIn.headers["cache-control"]).toBe("private, no-store");
  });
});
