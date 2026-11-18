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

const LIST_URL = "/api/v1/admin/files";
const STATS_URL = "/api/v1/admin/files/stats";

// A cover that a blog post uses: the file is in use.
async function attachAsCover(adminId: string, fileId: string) {
  return prisma.blogPost.create({
    data: {
      slug: `post-${crypto.randomUUID()}`,
      title: "Attached",
      body: "Body",
      authorId: adminId,
      coverFileId: fileId,
    },
  });
}

describe("admin files", () => {
  describe("GET /api/v1/admin/files", () => {
    it("rejects requests without a token and non-admins with 401 and 403", async () => {
      const app = await createTestApp();
      const student = await createAccount({ role: "STUDENT" });
      const pendingAdmin = await createAdmin({ status: "PENDING" });

      const anonymous = await app.inject({ method: "GET", url: LIST_URL });
      expect(anonymous.statusCode).toBe(401);

      for (const account of [student, pendingAdmin]) {
        const res = await app.inject({
          method: "GET",
          url: LIST_URL,
          headers: await getAuthHeaders(account),
        });
        expect(res.statusCode).toBe(403);
      }
    });

    it("filters by purpose, status and unattached, and flags published and inUse", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const owner = await createAccount({ role: "STUDENT" });

      const idle = await createFileAsset(owner.id, "STUDENT_ID", {
        createdAt: new Date("2026-03-01T00:00:00Z"),
      });
      const cover = await createFileAsset(admin.id, "BLOG_COVER", {
        createdAt: new Date("2026-03-02T00:00:00Z"),
        publishedAt: new Date("2026-03-02T01:00:00Z"),
      });
      await attachAsCover(admin.id, cover.id);
      const pendingVideo = await createFileAsset(owner.id, "TUTOR_VIDEO", {
        status: "PENDING_UPLOAD",
        createdAt: new Date("2026-03-03T00:00:00Z"),
      });

      const headers = await getAuthHeaders(admin);
      const ids = async (query: string) => {
        const res = await app.inject({ method: "GET", url: `${LIST_URL}${query}`, headers });
        expect(res.statusCode).toBe(200);
        return JSON.parse(res.body).files.map((f: { id: string }) => f.id);
      };

      // Newest first across all files.
      expect(await ids("")).toEqual([pendingVideo.id, cover.id, idle.id]);
      expect(await ids("?purpose=STUDENT_ID")).toEqual([idle.id]);
      expect(await ids("?status=PENDING_UPLOAD")).toEqual([pendingVideo.id]);
      expect(await ids("?unattached=true")).toEqual([pendingVideo.id, idle.id]);
      expect(await ids("?unattached=false")).toEqual([cover.id]);
      expect(await ids(`?ownerAccountId=${owner.id}`)).toEqual([pendingVideo.id, idle.id]);

      const res = await app.inject({
        method: "GET",
        url: `${LIST_URL}?purpose=BLOG_COVER`,
        headers,
      });
      const [row] = JSON.parse(res.body).files;
      expect(row).toMatchObject({
        id: cover.id,
        ownerAccountId: admin.id,
        ownerEmail: admin.email,
        published: true,
        inUse: true,
        status: "UPLOADED",
      });
    });

    it("pages with a cursor", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const owner = await createAccount({ role: "STUDENT" });
      const files = [];
      for (const day of [1, 2, 3]) {
        files.push(
          await createFileAsset(owner.id, "STUDENT_ID", {
            createdAt: new Date(`2026-03-0${day}T00:00:00Z`),
          }),
        );
      }
      const headers = await getAuthHeaders(admin);

      const first = JSON.parse(
        (await app.inject({ method: "GET", url: `${LIST_URL}?limit=2`, headers })).body,
      );
      expect(first.files.map((f: { id: string }) => f.id)).toEqual([files[2]?.id, files[1]?.id]);
      expect(first.nextCursor).toEqual(expect.any(String));

      const second = JSON.parse(
        (
          await app.inject({
            method: "GET",
            url: `${LIST_URL}?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`,
            headers,
          })
        ).body,
      );
      expect(second.files.map((f: { id: string }) => f.id)).toEqual([files[0]?.id]);
      expect(second.nextCursor).toBeNull();
    });
  });

  describe("GET /api/v1/admin/files/stats", () => {
    it("totals count and bytes per purpose and status", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const owner = await createAccount({ role: "TUTOR" });
      await createFileAsset(owner.id, "CREDENTIAL", { sizeBytes: 100 });
      await createFileAsset(owner.id, "CREDENTIAL", { sizeBytes: 250 });
      await createFileAsset(owner.id, "CREDENTIAL", { status: "DELETED", sizeBytes: 40 });

      const res = await app.inject({
        method: "GET",
        url: STATS_URL,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(200);
      const { groups } = JSON.parse(res.body);
      expect(groups).toContainEqual({
        purpose: "CREDENTIAL",
        status: "UPLOADED",
        count: 2,
        totalBytes: 350,
      });
      expect(groups).toContainEqual({
        purpose: "CREDENTIAL",
        status: "DELETED",
        count: 1,
        totalBytes: 40,
      });
    });

    it("rejects non-admins with 403", async () => {
      const app = await createTestApp();
      const tutor = await createAccount({ role: "TUTOR" });

      const res = await app.inject({
        method: "GET",
        url: STATS_URL,
        headers: await getAuthHeaders(tutor),
      });

      expect(res.statusCode).toBe(403);
    });
  });

  describe("DELETE /api/v1/admin/files/:id", () => {
    it("deletes an unattached file, removes its objects and writes an audit row", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const owner = await createAccount({ role: "STUDENT" });
      const file = await createFileAsset(owner.id, "STUDENT_ID");
      const fake = createFakeStorage();
      fake.put(file.storageKey, new Uint8Array([1, 2, 3]), "application/pdf");
      setStorageForTests(fake.storage);

      const res = await app.inject({
        method: "DELETE",
        url: `${LIST_URL}/${file.id}`,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(204);
      const row = await prisma.fileAsset.findUniqueOrThrow({ where: { id: file.id } });
      expect(row.status).toBe("DELETED");
      expect(fake.objects.has(file.storageKey)).toBe(false);

      const audit = await prisma.auditLog.findFirst({
        where: { action: "file.delete", entityId: file.id },
      });
      expect(audit).toMatchObject({
        actorAccountId: admin.id,
        entityType: "file_asset",
      });
    });

    it("refuses a file a record uses with 409 FILE_IN_USE", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const cover = await createFileAsset(admin.id, "BLOG_COVER");
      await attachAsCover(admin.id, cover.id);

      const res = await app.inject({
        method: "DELETE",
        url: `${LIST_URL}/${cover.id}`,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).code).toBe("FILE_IN_USE");
      const row = await prisma.fileAsset.findUniqueOrThrow({ where: { id: cover.id } });
      expect(row.status).toBe("UPLOADED");
    });

    it("answers 404 for an unknown file and 403 for non-admins", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const student = await createAccount({ role: "STUDENT" });
      const file = await createFileAsset(student.id, "STUDENT_ID");

      const missing = await app.inject({
        method: "DELETE",
        url: `${LIST_URL}/${crypto.randomUUID()}`,
        headers: await getAuthHeaders(admin),
      });
      expect(missing.statusCode).toBe(404);

      const denied = await app.inject({
        method: "DELETE",
        url: `${LIST_URL}/${file.id}`,
        headers: await getAuthHeaders(student),
      });
      expect(denied.statusCode).toBe(403);
    });
  });
});
