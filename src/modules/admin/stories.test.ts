import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "../../lib/prisma.js";
import { setStorageForTests } from "../../lib/storage.js";
import {
  createAccount,
  createAdmin,
  createArea,
  createFakeStorage,
  createFileAsset,
  createStoryRow,
  createStudentProfile,
  createTestApp,
  createTutorProfile,
  fakeFileBytes,
  getAuthHeaders,
} from "../../tests/helpers.js";
import defaults from "../site-content/defaults.json" with { type: "json" };

const BASE = "/api/v1/admin/stories";
const SITE = "/api/v1/admin/site-content/testimonials";

// biome-ignore lint/suspicious/noExplicitAny: test fixtures
type Json = Record<string, any>;

describe("admin stories", () => {
  afterEach(() => {
    setStorageForTests(null);
  });

  describe("GET /", () => {
    it("rejects a student with 403", async () => {
      const app = await createTestApp();
      const student = await createAccount({ role: "STUDENT" });

      const res = await app.inject({
        method: "GET",
        url: BASE,
        headers: await getAuthHeaders(student),
      });

      expect(res.statusCode).toBe(403);
    });

    it("lists PENDING by default, newest first, with the author and the story's files", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const author = await createAccount({ role: "STUDENT" });
      const area = await createArea();
      await createStudentProfile(author.id, area.id, { name: "Nadia Rahman" });
      const image = await createFileAsset(author.id, "STORY_IMAGE", {
        contentType: "image/png",
        originalName: "me.png",
      });
      const older = await createStoryRow(author.id, {
        status: "PENDING",
        createdAt: new Date("2026-11-01T10:00:00Z"),
      });
      // One pending story per author, so the newer one comes from a second author.
      const second = await createAccount({ role: "STUDENT" });
      await createStudentProfile(second.id, area.id, { name: "Second Author" });
      const newer = await createStoryRow(second.id, {
        status: "PENDING",
        imageFileId: image.id,
        createdAt: new Date("2026-11-02T10:00:00Z"),
      });
      await createStoryRow(author.id, {
        status: "APPROVED",
        createdAt: new Date("2026-11-03T10:00:00Z"),
      });

      const res = await app.inject({
        method: "GET",
        url: BASE,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(200);
      const { stories, nextCursor } = JSON.parse(res.body);
      expect(nextCursor).toBeNull();
      expect(stories.map((s: Json) => s.id)).toEqual([newer.id, older.id]);
      expect(stories[0]).toMatchObject({
        author: { accountId: second.id, name: "Second Author", role: "STUDENT" },
        role: "STUDENT",
        status: "PENDING",
        onLanding: false,
        image: { contentType: "image/png", originalName: "me.png" },
        video: null,
      });
    });

    it("filters by status and role, and pages with a cursor", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const student = await createAccount({ role: "STUDENT" });
      const tutor = await createAccount({ role: "TUTOR" });
      const rejected = await createStoryRow(student.id, { status: "REJECTED" });
      await createStoryRow(tutor.id, { role: "TUTOR", status: "APPROVED" });
      const second = await createStoryRow(student.id, { status: "APPROVED" });

      const approvedStudents = JSON.parse(
        (
          await app.inject({
            method: "GET",
            url: `${BASE}?status=APPROVED&role=STUDENT`,
            headers: await getAuthHeaders(admin),
          })
        ).body,
      );
      const page1 = JSON.parse(
        (
          await app.inject({
            method: "GET",
            url: `${BASE}?status=APPROVED&limit=1`,
            headers: await getAuthHeaders(admin),
          })
        ).body,
      );
      const page2 = JSON.parse(
        (
          await app.inject({
            method: "GET",
            url: `${BASE}?status=APPROVED&limit=1&cursor=${encodeURIComponent(page1.nextCursor)}`,
            headers: await getAuthHeaders(admin),
          })
        ).body,
      );
      const rejectedOnly = JSON.parse(
        (
          await app.inject({
            method: "GET",
            url: `${BASE}?status=REJECTED`,
            headers: await getAuthHeaders(admin),
          })
        ).body,
      );

      expect(approvedStudents.stories.map((s: Json) => s.id)).toEqual([second.id]);
      expect(page1.stories).toHaveLength(1);
      expect(page1.nextCursor).not.toBeNull();
      expect(page2.stories).toHaveLength(1);
      expect(page2.stories[0].id).not.toBe(page1.stories[0].id);
      expect(rejectedOnly.stories.map((s: Json) => s.id)).toEqual([rejected.id]);
    });
  });

  describe("POST /:id/moderate", () => {
    it("approve publishes the story's photo, marks it approved and alerts the author", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const author = await createAccount({ role: "STUDENT" });
      const fake = createFakeStorage();
      setStorageForTests(fake.storage);
      const image = await createFileAsset(author.id, "STORY_IMAGE", { contentType: "image/png" });
      fake.put(image.storageKey, fakeFileBytes("image/png", 64), "image/png");
      const story = await createStoryRow(author.id, { imageFileId: image.id });

      const res = await app.inject({
        method: "POST",
        url: `${BASE}/${story.id}/moderate`,
        headers: await getAuthHeaders(admin),
        payload: { decision: "APPROVE", noteVisible: true },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({ status: "APPROVED", note: null });
      expect(fake.publicObjects.has(image.storageKey)).toBe(true);
      const alert = await prisma.appNotification.findFirstOrThrow({
        where: { recipientId: author.id, kind: "STORY_APPROVED" },
      });
      expect(alert.note).toBeNull();
      expect(alert.filePurpose).toBeNull();
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: "story.moderate", entityId: story.id },
      });
      expect(audit.actorAccountId).toBe(admin.id);
    });

    it("reject needs a note (400)", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const author = await createAccount({ role: "TUTOR" });
      const story = await createStoryRow(author.id, { role: "TUTOR" });

      const res = await app.inject({
        method: "POST",
        url: `${BASE}/${story.id}/moderate`,
        headers: await getAuthHeaders(admin),
        payload: { decision: "REJECT", noteVisible: true },
      });

      expect(res.statusCode).toBe(400);
      const row = await prisma.story.findUniqueOrThrow({ where: { id: story.id } });
      expect(row.status).toBe("PENDING");
    });

    it("a visible rejection note reaches the author, a hidden one does not", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const visibleAuthor = await createAccount({ role: "TUTOR" });
      const hiddenAuthor = await createAccount({ role: "TUTOR" });
      await createTutorProfile(hiddenAuthor.id);
      const visible = await createStoryRow(visibleAuthor.id, { role: "TUTOR" });
      const hidden = await createStoryRow(hiddenAuthor.id, { role: "TUTOR" });

      await app.inject({
        method: "POST",
        url: `${BASE}/${visible.id}/moderate`,
        headers: await getAuthHeaders(admin),
        payload: { decision: "REJECT", note: "Please share a longer example.", noteVisible: true },
      });
      await app.inject({
        method: "POST",
        url: `${BASE}/${hidden.id}/moderate`,
        headers: await getAuthHeaders(admin),
        payload: { decision: "REJECT", note: "Internal: duplicate account.", noteVisible: false },
      });

      const shown = await prisma.appNotification.findFirstOrThrow({
        where: { recipientId: visibleAuthor.id, kind: "STORY_REJECTED" },
      });
      const kept = await prisma.appNotification.findFirstOrThrow({
        where: { recipientId: hiddenAuthor.id, kind: "STORY_REJECTED" },
      });
      expect(shown.note).toBe("Please share a longer example.");
      expect(kept.note).toBeNull();

      const authorView = JSON.parse(
        (
          await app.inject({
            method: "GET",
            url: "/api/v1/me/stories",
            headers: await getAuthHeaders(hiddenAuthor),
          })
        ).body,
      );
      expect(authorView.stories[0].note).toBeNull();
      expect(authorView.stories[0].status).toBe("REJECTED");
    });

    it("the same decision again answers 409 STORY_ALREADY_MODERATED", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const author = await createAccount({ role: "STUDENT" });
      const story = await createStoryRow(author.id, { status: "APPROVED" });

      const res = await app.inject({
        method: "POST",
        url: `${BASE}/${story.id}/moderate`,
        headers: await getAuthHeaders(admin),
        payload: { decision: "APPROVE", noteVisible: true },
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).code).toBe("STORY_ALREADY_MODERATED");
    });

    it("rejecting an approved story takes it off the landing page and its photo down", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const author = await createAccount({ role: "STUDENT" });
      const fake = createFakeStorage();
      setStorageForTests(fake.storage);
      const image = await createFileAsset(author.id, "STORY_IMAGE", { contentType: "image/png" });
      fake.put(image.storageKey, fakeFileBytes("image/png", 64), "image/png");
      const story = await createStoryRow(author.id, { status: "APPROVED", imageFileId: image.id });
      const value = structuredClone((defaults as Json).testimonials);
      value.items = [
        {
          name: "Ana",
          role: "Student",
          photo: `file:${image.id}`,
          quote: "Great help",
          comment: "Clear lessons every week",
          source: { kind: "story", id: story.id },
        },
      ];
      const put = await app.inject({
        method: "PUT",
        url: SITE,
        headers: await getAuthHeaders(admin),
        payload: { value, expectedUpdatedAt: null },
      });
      expect(put.statusCode).toBe(200);
      expect(fake.publicObjects.has(image.storageKey)).toBe(true);

      const res = await app.inject({
        method: "POST",
        url: `${BASE}/${story.id}/moderate`,
        headers: await getAuthHeaders(admin),
        payload: { decision: "REJECT", note: "Photo is not the author.", noteVisible: true },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({ status: "REJECTED", onLanding: false });
      expect(await prisma.siteContent.count({ where: { key: "testimonials" } })).toBe(0);
      expect(await prisma.siteContentFile.count({ where: { key: "testimonials" } })).toBe(0);
      const audit = await prisma.auditLog.findFirst({
        where: { action: "site_content.source_removed", entityId: "testimonials" },
      });
      expect(audit?.actorAccountId).toBe(admin.id);
      expect(fake.publicObjects.has(image.storageKey)).toBe(false);
    });
  });
});
