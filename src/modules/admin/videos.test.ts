import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "../../lib/prisma.js";
import { setStorageForTests } from "../../lib/storage.js";
import {
  createAccount,
  createAdmin,
  createFakeStorage,
  createFileAsset,
  createTestApp,
  createTutorProfile,
  fakeFileBytes,
  getAuthHeaders,
} from "../../tests/helpers.js";

const BASE = "/api/v1/admin/videos";

// A tutor with an uploaded video. Tests put the private object into the fake storage themselves.
async function uploadVideo(
  options: { status?: "PENDING" | "APPROVED" | "REJECTED"; createdAt?: Date } = {},
) {
  const account = await createAccount({ role: "TUTOR" });
  const tutor = await createTutorProfile(account.id);
  const file = await createFileAsset(account.id, "TUTOR_VIDEO", {
    contentType: "video/mp4",
    sizeBytes: 1024,
    originalName: "intro.mp4",
  });
  const video = await prisma.tutorVideo.create({
    data: {
      tutorId: tutor.id,
      fileId: file.id,
      title: "Intro to algebra",
      status: options.status ?? "PENDING",
      createdAt: options.createdAt,
    },
  });
  return { tutor, file, video, account };
}

describe("admin tutor videos", () => {
  afterEach(() => {
    setStorageForTests(null);
  });

  describe("GET /", () => {
    it("rejects non-admins with 403", async () => {
      const app = await createTestApp();
      const student = await createAccount({ role: "STUDENT" });

      const res = await app.inject({
        method: "GET",
        url: BASE,
        headers: await getAuthHeaders(student),
      });

      expect(res.statusCode).toBe(403);
    });

    it("lists PENDING oldest first, APPROVED newest first, and pages with nextCursor", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const headers = await getAuthHeaders(admin);
      const oldest = await uploadVideo({ createdAt: new Date("2026-06-01T00:00:00Z") });
      const newest = await uploadVideo({ createdAt: new Date("2026-06-03T00:00:00Z") });
      const approvedOld = await uploadVideo({
        status: "APPROVED",
        createdAt: new Date("2026-05-01T00:00:00Z"),
      });
      const approvedNew = await uploadVideo({
        status: "APPROVED",
        createdAt: new Date("2026-05-02T00:00:00Z"),
      });

      const pending = await app.inject({ method: "GET", url: `${BASE}?limit=1`, headers });
      expect(pending.statusCode).toBe(200);
      const pendingBody = JSON.parse(pending.body);
      expect(pendingBody.videos[0]).toMatchObject({
        id: oldest.video.id,
        status: "PENDING",
        title: "Intro to algebra",
        url: null,
        file: { id: oldest.file.id, purpose: "TUTOR_VIDEO", fileName: "intro.mp4" },
        tutor: { id: oldest.tutor.id, verificationStatus: "NOT_SUBMITTED" },
      });
      expect(pendingBody.nextCursor).toEqual(expect.any(String));

      const pendingNext = await app.inject({
        method: "GET",
        url: `${BASE}?limit=1&cursor=${encodeURIComponent(pendingBody.nextCursor)}`,
        headers,
      });
      expect(JSON.parse(pendingNext.body).videos.map((v: { id: string }) => v.id)).toEqual([
        newest.video.id,
      ]);

      const approved = await app.inject({
        method: "GET",
        url: `${BASE}?status=APPROVED`,
        headers,
      });
      expect(JSON.parse(approved.body).videos.map((v: { id: string }) => v.id)).toEqual([
        approvedNew.video.id,
        approvedOld.video.id,
      ]);
    });
  });

  describe("POST /:id/moderate", () => {
    it("approve publishes the file and returns the public url", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const fake = createFakeStorage();
      setStorageForTests(fake.storage);
      const { file, video } = await uploadVideo();
      fake.put(file.storageKey, fakeFileBytes("video/mp4", 1024), "video/mp4");

      const res = await app.inject({
        method: "POST",
        url: `${BASE}/${video.id}/moderate`,
        headers: await getAuthHeaders(admin),
        payload: { decision: "APPROVE" },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({
        id: video.id,
        status: "APPROVED",
        moderationNote: null,
        url: `https://media.test/${file.storageKey}`,
      });
      const row = await prisma.fileAsset.findUniqueOrThrow({ where: { id: file.id } });
      expect(row.publishedAt).not.toBeNull();
      expect(fake.publicObjects.has(file.storageKey)).toBe(true);
    });

    it("take down (REJECT an approved video) removes the public copy", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const fake = createFakeStorage();
      setStorageForTests(fake.storage);
      const { file, video } = await uploadVideo();
      fake.put(file.storageKey, fakeFileBytes("video/mp4", 1024), "video/mp4");
      const approve = await app.inject({
        method: "POST",
        url: `${BASE}/${video.id}/moderate`,
        headers: await getAuthHeaders(admin),
        payload: { decision: "APPROVE" },
      });
      expect(approve.statusCode).toBe(200);
      expect(fake.publicObjects.has(file.storageKey)).toBe(true);

      const res = await app.inject({
        method: "POST",
        url: `${BASE}/${video.id}/moderate`,
        headers: await getAuthHeaders(admin),
        payload: { decision: "REJECT", note: "Audio is not audible" },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({
        status: "REJECTED",
        moderationNote: "Audio is not audible",
        url: `https://fake-r2.test/private/${file.storageKey}?get&expires=3600`,
      });
      const row = await prisma.fileAsset.findUniqueOrThrow({ where: { id: file.id } });
      expect(row.publishedAt).toBeNull();
      expect(fake.publicObjects.has(file.storageKey)).toBe(false);
    });

    it("the same decision twice gets 409 VIDEO_ALREADY_MODERATED", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const { video } = await uploadVideo();
      const headers = await getAuthHeaders(admin);

      const first = await app.inject({
        method: "POST",
        url: `${BASE}/${video.id}/moderate`,
        headers,
        payload: { decision: "APPROVE" },
      });
      expect(first.statusCode).toBe(200);

      const second = await app.inject({
        method: "POST",
        url: `${BASE}/${video.id}/moderate`,
        headers,
        payload: { decision: "APPROVE" },
      });
      expect(second.statusCode).toBe(409);
      expect(JSON.parse(second.body).code).toBe("VIDEO_ALREADY_MODERATED");
    });

    it("reject without a note gets 400", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const { video } = await uploadVideo();

      const res = await app.inject({
        method: "POST",
        url: `${BASE}/${video.id}/moderate`,
        headers: await getAuthHeaders(admin),
        payload: { decision: "REJECT" },
      });

      expect(res.statusCode).toBe(400);
      const row = await prisma.tutorVideo.findUniqueOrThrow({ where: { id: video.id } });
      expect(row.status).toBe("PENDING");
    });

    it("writes a video.moderate audit row", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const { video } = await uploadVideo();

      await app.inject({
        method: "POST",
        url: `${BASE}/${video.id}/moderate`,
        headers: await getAuthHeaders(admin),
        payload: { decision: "APPROVE" },
      });

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { entityType: "tutor_video", entityId: video.id, action: "video.moderate" },
      });
      expect(audit.actorAccountId).toBe(admin.id);
      expect(audit.before).toEqual({ status: "PENDING" });
      expect(audit.after).toEqual({ status: "APPROVED", note: null, noteVisible: true });
    });

    it("returns 404 for an unknown id", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });

      const res = await app.inject({
        method: "POST",
        url: `${BASE}/${crypto.randomUUID()}/moderate`,
        headers: await getAuthHeaders(admin),
        payload: { decision: "APPROVE" },
      });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).code).toBe("NOT_FOUND");
    });
  });

  describe("PATCH /:id", () => {
    it("sets sortOrder and writes a video.update audit row", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const { video } = await uploadVideo();

      const res = await app.inject({
        method: "PATCH",
        url: `${BASE}/${video.id}`,
        headers: await getAuthHeaders(admin),
        payload: { sortOrder: 5 },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({ id: video.id, sortOrder: 5 });
      const row = await prisma.tutorVideo.findUniqueOrThrow({ where: { id: video.id } });
      expect(row.sortOrder).toBe(5);

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { entityType: "tutor_video", entityId: video.id, action: "video.update" },
      });
      expect(audit.before).toEqual({ sortOrder: 0 });
      expect(audit.after).toEqual({ sortOrder: 5 });
    });

    it("rejects a sortOrder outside 0-10000 with 400", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const { video } = await uploadVideo();

      const res = await app.inject({
        method: "PATCH",
        url: `${BASE}/${video.id}`,
        headers: await getAuthHeaders(admin),
        payload: { sortOrder: 10001 },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  it("url is null when no storage is configured", async () => {
    const app = await createTestApp();
    const admin = await createAdmin({ status: "ACTIVE" });
    await uploadVideo({ status: "APPROVED" });

    const res = await app.inject({
      method: "GET",
      url: `${BASE}?status=APPROVED`,
      headers: await getAuthHeaders(admin),
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).videos[0].url).toBeNull();
  });
});

describe("admin tutor video moderation history", () => {
  const issueRow = (
    accountId: string,
    action: "REJECTED" | "REVOKED" | "REMOVED" | "APPROVED",
    createdAt?: Date,
  ) =>
    prisma.uploadReview.create({
      data: {
        accountId,
        purpose: "TUTOR_VIDEO",
        action,
        note: action === "APPROVED" ? null : "Earlier problem with the upload",
        noteVisible: true,
        createdAt,
      },
    });

  it("approve writes one upload history row and a VIDEO_APPROVED alert without a note", async () => {
    const app = await createTestApp();
    const admin = await createAdmin({ status: "ACTIVE" });
    const { account, file, video } = await uploadVideo();

    const res = await app.inject({
      method: "POST",
      url: `${BASE}/${video.id}/moderate`,
      headers: await getAuthHeaders(admin),
      payload: { decision: "APPROVE", noteVisible: false },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      moderationNote: null,
      noteVisible: true,
      tutor: { accountId: account.id },
      uploadFlags: { recentIssues: 0, uploadsBlocked: false },
    });
    const reviews = await prisma.uploadReview.findMany({ where: { accountId: account.id } });
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      action: "APPROVED",
      fileId: file.id,
      purpose: "TUTOR_VIDEO",
      fileName: "intro.mp4",
      note: null,
      actorAccountId: admin.id,
    });
    const alerts = await prisma.appNotification.findMany({ where: { recipientId: account.id } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      kind: "VIDEO_APPROVED",
      note: null,
      filePurpose: "TUTOR_VIDEO",
    });
  });

  it("a rejection with a hidden note keeps the note from the tutor", async () => {
    const app = await createTestApp();
    const admin = await createAdmin({ status: "ACTIVE" });
    const { account, video } = await uploadVideo();

    const res = await app.inject({
      method: "POST",
      url: `${BASE}/${video.id}/moderate`,
      headers: await getAuthHeaders(admin),
      payload: { decision: "REJECT", note: "Audio is not audible", noteVisible: false },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      status: "REJECTED",
      moderationNote: "Audio is not audible",
      noteVisible: false,
    });
    const row = await prisma.tutorVideo.findUniqueOrThrow({ where: { id: video.id } });
    expect(row.noteVisible).toBe(false);
    const review = await prisma.uploadReview.findFirstOrThrow({ where: { accountId: account.id } });
    expect(review).toMatchObject({
      action: "REJECTED",
      note: "Audio is not audible",
      noteVisible: false,
    });
    const alert = await prisma.appNotification.findFirstOrThrow({
      where: { recipientId: account.id },
    });
    expect(alert).toMatchObject({ kind: "VIDEO_REJECTED", note: null });
  });

  it("a visible rejection note reaches the tutor's alert", async () => {
    const app = await createTestApp();
    const admin = await createAdmin({ status: "ACTIVE" });
    const { account, video } = await uploadVideo();

    await app.inject({
      method: "POST",
      url: `${BASE}/${video.id}/moderate`,
      headers: await getAuthHeaders(admin),
      payload: { decision: "REJECT", note: "Audio is not audible" },
    });

    const alert = await prisma.appNotification.findFirstOrThrow({
      where: { recipientId: account.id },
    });
    expect(alert).toMatchObject({ kind: "VIDEO_REJECTED", note: "Audio is not audible" });
  });

  it("each decision adds one history row, take-down included", async () => {
    const app = await createTestApp();
    const admin = await createAdmin({ status: "ACTIVE" });
    const headers = await getAuthHeaders(admin);
    const { account, video } = await uploadVideo();

    await app.inject({
      method: "POST",
      url: `${BASE}/${video.id}/moderate`,
      headers,
      payload: { decision: "APPROVE" },
    });
    await app.inject({
      method: "POST",
      url: `${BASE}/${video.id}/moderate`,
      headers,
      payload: { decision: "REJECT", note: "Off topic for the profile" },
    });
    await app.inject({
      method: "POST",
      url: `${BASE}/${video.id}/moderate`,
      headers,
      payload: { decision: "APPROVE" },
    });

    const reviews = await prisma.uploadReview.findMany({
      where: { accountId: account.id },
      orderBy: { createdAt: "asc" },
    });
    expect(reviews.map((r) => r.action)).toEqual(["APPROVED", "REJECTED", "APPROVED"]);
    const alerts = await prisma.appNotification.count({ where: { recipientId: account.id } });
    expect(alerts).toBe(3);
  });

  it("uploadFlags counts the tutor's issues from the last 30 days and an active block", async () => {
    const app = await createTestApp();
    const admin = await createAdmin({ status: "ACTIVE" });
    const { account } = await uploadVideo();
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    await issueRow(account.id, "REJECTED");
    await issueRow(account.id, "REVOKED");
    await issueRow(account.id, "REMOVED");
    await issueRow(account.id, "APPROVED");
    await issueRow(account.id, "REJECTED", old);

    const headers = await getAuthHeaders(admin);
    const list = JSON.parse((await app.inject({ method: "GET", url: BASE, headers })).body);
    expect(list.videos[0].uploadFlags).toEqual({ recentIssues: 3, uploadsBlocked: false });

    await prisma.uploadBlock.create({
      data: {
        accountId: account.id,
        blocksVideos: true,
        blocksDocuments: false,
        note: "Paused while we check the uploads",
      },
    });
    const blocked = JSON.parse((await app.inject({ method: "GET", url: BASE, headers })).body);
    expect(blocked.videos[0].uploadFlags).toEqual({ recentIssues: 3, uploadsBlocked: true });
  });
});
