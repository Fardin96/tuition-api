import { describe, expect, it } from "vitest";
import { prisma } from "../../lib/prisma.js";
import { setStorageForTests } from "../../lib/storage.js";
import {
  createAccount,
  createAdmin,
  createFakeStorage,
  createFileAsset,
  createTestApp,
  fakeFileBytes,
  getAuthHeaders,
} from "../../tests/helpers.js";

const LIST_URL = "/api/v1/admin/blog";

function postBody(overrides: Record<string, unknown> = {}) {
  return { title: "Study Tips for Exams", body: "# Tips\n\nStart early.", ...overrides };
}

describe("admin blog", () => {
  describe("POST /api/v1/admin/blog", () => {
    it("rejects non-admins with 403", async () => {
      const app = await createTestApp();
      const student = await createAccount({ role: "STUDENT" });

      const res = await app.inject({
        method: "POST",
        url: LIST_URL,
        headers: await getAuthHeaders(student),
        payload: postBody(),
      });

      expect(res.statusCode).toBe(403);
    });

    it("creates a draft with a slug from the title", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });

      const res = await app.inject({
        method: "POST",
        url: LIST_URL,
        headers: await getAuthHeaders(admin),
        payload: postBody({ title: "  Study Tips: Exams & More!  " }),
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body).toMatchObject({
        slug: "study-tips-exams-more",
        status: "DRAFT",
        publishedAt: null,
        cover: null,
        authorId: admin.id,
      });
      expect(body.authorName).toBe("Test Admin");

      const audit = await prisma.auditLog.findFirst({
        where: { action: "blog.create", entityId: body.id },
      });
      expect(audit?.actorAccountId).toBe(admin.id);
    });

    it("answers 409 BLOG_SLUG_EXISTS for a taken slug", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const headers = await getAuthHeaders(admin);
      await app.inject({ method: "POST", url: LIST_URL, headers, payload: postBody() });

      const res = await app.inject({
        method: "POST",
        url: LIST_URL,
        headers,
        payload: postBody({ title: "Another Title", slug: "study-tips-for-exams" }),
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).code).toBe("BLOG_SLUG_EXISTS");
    });

    it("answers 400 when the title gives no slug and none is sent", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });

      const res = await app.inject({
        method: "POST",
        url: LIST_URL,
        headers: await getAuthHeaders(admin),
        payload: postBody({ title: "পরীক্ষার টিপস" }),
      });

      expect(res.statusCode).toBe(400);
    });

    it("attaches a cover the admin uploaded and publishes it", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const cover = await createFileAsset(admin.id, "BLOG_COVER", { contentType: "image/png" });
      const fake = createFakeStorage();
      fake.put(cover.storageKey, fakeFileBytes("image/png", 64), "image/png");
      setStorageForTests(fake.storage);

      const res = await app.inject({
        method: "POST",
        url: LIST_URL,
        headers: await getAuthHeaders(admin),
        payload: postBody({ coverFileId: cover.id, status: "PUBLISHED" }),
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.cover).toEqual({
        fileId: cover.id,
        url: `https://media.test/${cover.storageKey}`,
      });
      expect(body.publishedAt).not.toBeNull();
      const row = await prisma.fileAsset.findUniqueOrThrow({ where: { id: cover.id } });
      expect(row.publishedAt).not.toBeNull();
    });

    it("refuses a cover owned by another account with 400 INVALID_FILE", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const other = await createAdmin({ status: "ACTIVE" });
      const cover = await createFileAsset(other.id, "BLOG_COVER");

      const res = await app.inject({
        method: "POST",
        url: LIST_URL,
        headers: await getAuthHeaders(admin),
        payload: postBody({ coverFileId: cover.id }),
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe("INVALID_FILE");
    });
  });

  describe("PATCH /api/v1/admin/blog/:id", () => {
    it("sets publishedAt on publish and keeps it on later edits", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const headers = await getAuthHeaders(admin);
      const created = JSON.parse(
        (await app.inject({ method: "POST", url: LIST_URL, headers, payload: postBody() })).body,
      );
      expect(created.publishedAt).toBeNull();

      const published = await app.inject({
        method: "PATCH",
        url: `${LIST_URL}/${created.id}`,
        headers,
        payload: { status: "PUBLISHED" },
      });
      expect(published.statusCode).toBe(200);
      const first = JSON.parse(published.body);
      expect(first.status).toBe("PUBLISHED");
      expect(first.publishedAt).not.toBeNull();

      const edited = await app.inject({
        method: "PATCH",
        url: `${LIST_URL}/${created.id}`,
        headers,
        payload: { title: "Study Tips, Revised" },
      });
      expect(JSON.parse(edited.body).publishedAt).toBe(first.publishedAt);
    });

    it("removes the cover with coverFileId null and keeps the old file", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const headers = await getAuthHeaders(admin);
      const cover = await createFileAsset(admin.id, "BLOG_COVER");
      const created = JSON.parse(
        (
          await app.inject({
            method: "POST",
            url: LIST_URL,
            headers,
            payload: postBody({ coverFileId: cover.id }),
          })
        ).body,
      );
      expect(created.cover?.fileId).toBe(cover.id);

      const res = await app.inject({
        method: "PATCH",
        url: `${LIST_URL}/${created.id}`,
        headers,
        payload: { coverFileId: null },
      });

      expect(JSON.parse(res.body).cover).toBeNull();
      const file = await prisma.fileAsset.findUniqueOrThrow({ where: { id: cover.id } });
      expect(file.status).toBe("UPLOADED");
    });

    it("archives a post and rejects an empty body with 400", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const headers = await getAuthHeaders(admin);
      const created = JSON.parse(
        (await app.inject({ method: "POST", url: LIST_URL, headers, payload: postBody() })).body,
      );

      const empty = await app.inject({
        method: "PATCH",
        url: `${LIST_URL}/${created.id}`,
        headers,
        payload: {},
      });
      expect(empty.statusCode).toBe(400);

      const archived = await app.inject({
        method: "PATCH",
        url: `${LIST_URL}/${created.id}`,
        headers,
        payload: { status: "ARCHIVED" },
      });
      expect(JSON.parse(archived.body).status).toBe("ARCHIVED");

      const audit = await prisma.auditLog.findFirst({
        where: { action: "blog.update", entityId: created.id },
      });
      expect(audit?.after).toEqual({ status: "ARCHIVED" });
    });

    it("answers 409 BLOG_SLUG_EXISTS when a new slug is taken", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const headers = await getAuthHeaders(admin);
      await app.inject({ method: "POST", url: LIST_URL, headers, payload: postBody() });
      const other = JSON.parse(
        (
          await app.inject({
            method: "POST",
            url: LIST_URL,
            headers,
            payload: postBody({ title: "Other Post" }),
          })
        ).body,
      );

      const res = await app.inject({
        method: "PATCH",
        url: `${LIST_URL}/${other.id}`,
        headers,
        payload: { slug: "study-tips-for-exams" },
      });

      expect(res.statusCode).toBe(409);
    });
  });

  describe("DELETE /api/v1/admin/blog/:id", () => {
    it("deletes a draft with 204 and discards its cover", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const headers = await getAuthHeaders(admin);
      const cover = await createFileAsset(admin.id, "BLOG_COVER");
      const created = JSON.parse(
        (
          await app.inject({
            method: "POST",
            url: LIST_URL,
            headers,
            payload: postBody({ coverFileId: cover.id }),
          })
        ).body,
      );

      const res = await app.inject({
        method: "DELETE",
        url: `${LIST_URL}/${created.id}`,
        headers,
      });

      expect(res.statusCode).toBe(204);
      expect(await prisma.blogPost.findUnique({ where: { id: created.id } })).toBeNull();
      const file = await prisma.fileAsset.findUniqueOrThrow({ where: { id: cover.id } });
      expect(file.status).toBe("DELETED");
      const audit = await prisma.auditLog.findFirst({
        where: { action: "blog.delete", entityId: created.id },
      });
      expect(audit).not.toBeNull();
    });

    it("refuses a published post with 409 INVALID_POST_STATE", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const headers = await getAuthHeaders(admin);
      const created = JSON.parse(
        (
          await app.inject({
            method: "POST",
            url: LIST_URL,
            headers,
            payload: postBody({ status: "PUBLISHED" }),
          })
        ).body,
      );

      const res = await app.inject({
        method: "DELETE",
        url: `${LIST_URL}/${created.id}`,
        headers,
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).code).toBe("INVALID_POST_STATE");
    });
  });

  describe("GET /api/v1/admin/blog", () => {
    it("lists drafts and archived posts, filtered by status", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const headers = await getAuthHeaders(admin);
      const draft = JSON.parse(
        (
          await app.inject({
            method: "POST",
            url: LIST_URL,
            headers,
            payload: postBody({ title: "Draft One" }),
          })
        ).body,
      );
      const published = JSON.parse(
        (
          await app.inject({
            method: "POST",
            url: LIST_URL,
            headers,
            payload: postBody({ title: "Live One", status: "PUBLISHED" }),
          })
        ).body,
      );

      const all = JSON.parse((await app.inject({ method: "GET", url: LIST_URL, headers })).body);
      expect(all.posts.map((p: { id: string }) => p.id)).toEqual([published.id, draft.id]);

      const drafts = JSON.parse(
        (await app.inject({ method: "GET", url: `${LIST_URL}?status=DRAFT`, headers })).body,
      );
      expect(drafts.posts.map((p: { id: string }) => p.id)).toEqual([draft.id]);

      const single = await app.inject({
        method: "GET",
        url: `${LIST_URL}/${draft.id}`,
        headers,
      });
      expect(single.statusCode).toBe(200);
    });
  });
});
