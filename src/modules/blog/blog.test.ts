import { describe, expect, it } from "vitest";
import { prisma } from "../../lib/prisma.js";
import { setStorageForTests } from "../../lib/storage.js";
import {
  createAccount,
  createAdmin,
  createFakeStorage,
  createFileAsset,
  createTestApp,
  getAuthHeaders,
} from "../../tests/helpers.js";

const LIST_URL = "/api/v1/blog";
const CACHE = "public, max-age=300, stale-while-revalidate=600";

async function createPost(
  authorId: string,
  overrides: {
    slug: string;
    status?: "DRAFT" | "PUBLISHED" | "ARCHIVED";
    publishedAt?: Date | null;
    coverFileId?: string | null;
  },
) {
  const status = overrides.status ?? "PUBLISHED";
  return prisma.blogPost.create({
    data: {
      slug: overrides.slug,
      title: `Title ${overrides.slug}`,
      excerpt: "Short summary",
      body: "# Body",
      status,
      publishedAt:
        overrides.publishedAt === undefined
          ? status === "PUBLISHED"
            ? new Date()
            : null
          : overrides.publishedAt,
      authorId,
      coverFileId: overrides.coverFileId ?? null,
    },
  });
}

describe("public blog", () => {
  describe("GET /api/v1/blog", () => {
    it("lists only published posts, newest first, with pagination", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const oldest = await createPost(admin.id, {
        slug: "oldest",
        publishedAt: new Date("2026-02-01T00:00:00Z"),
      });
      const newest = await createPost(admin.id, {
        slug: "newest",
        publishedAt: new Date("2026-04-01T00:00:00Z"),
      });
      const middle = await createPost(admin.id, {
        slug: "middle",
        publishedAt: new Date("2026-03-01T00:00:00Z"),
      });
      await createPost(admin.id, { slug: "draft-post", status: "DRAFT" });
      await createPost(admin.id, { slug: "archived-post", status: "ARCHIVED" });

      const first = await app.inject({ method: "GET", url: `${LIST_URL}?limit=2` });
      expect(first.statusCode).toBe(200);
      const firstBody = JSON.parse(first.body);
      expect(firstBody.posts.map((p: { slug: string }) => p.slug)).toEqual([
        newest.slug,
        middle.slug,
      ]);
      expect(firstBody.posts[0]).toMatchObject({
        title: "Title newest",
        excerpt: "Short summary",
        coverUrl: null,
      });
      expect(firstBody.nextCursor).toEqual(expect.any(String));

      const second = await app.inject({
        method: "GET",
        url: `${LIST_URL}?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
      });
      const secondBody = JSON.parse(second.body);
      expect(secondBody.posts.map((p: { slug: string }) => p.slug)).toEqual([oldest.slug]);
      expect(secondBody.nextCursor).toBeNull();
    });

    it("returns a public cover URL for a published cover", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const cover = await createFileAsset(admin.id, "BLOG_COVER", {
        contentType: "image/png",
        publishedAt: new Date(),
      });
      await createPost(admin.id, { slug: "with-cover", coverFileId: cover.id });
      setStorageForTests(createFakeStorage().storage);

      const res = await app.inject({ method: "GET", url: LIST_URL });

      const [post] = JSON.parse(res.body).posts;
      expect(post.coverUrl).toBe(`https://media.test/${cover.storageKey}`);
    });

    it("sends a public cache header to anonymous callers", async () => {
      const app = await createTestApp();

      const res = await app.inject({ method: "GET", url: LIST_URL });

      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe(CACHE);
    });

    it("does not cache responses for signed-in callers", async () => {
      const app = await createTestApp();
      const reader = await createAccount({ role: "STUDENT" });

      const res = await app.inject({
        method: "GET",
        url: LIST_URL,
        headers: await getAuthHeaders(reader),
      });

      expect(res.headers["cache-control"]).toBe("private, no-store");
    });
  });

  describe("GET /api/v1/blog/:slug", () => {
    it("returns a published post", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      await createPost(admin.id, { slug: "live-post" });

      const res = await app.inject({ method: "GET", url: `${LIST_URL}/live-post` });

      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe(CACHE);
      expect(JSON.parse(res.body)).toMatchObject({
        slug: "live-post",
        body: "# Body",
        coverUrl: null,
      });
    });

    it("answers 404 for drafts and archived posts without a public cache header", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      await createPost(admin.id, { slug: "draft-only", status: "DRAFT" });
      await createPost(admin.id, { slug: "old-post", status: "ARCHIVED" });

      for (const slug of ["draft-only", "old-post", "missing"]) {
        const res = await app.inject({ method: "GET", url: `${LIST_URL}/${slug}` });
        expect(res.statusCode).toBe(404);
        expect(res.headers["cache-control"]).not.toBe(CACHE);
      }
    });
  });
});
