import { describe, expect, it } from "vitest";
import { prisma } from "../../lib/prisma.js";
import { setStorageForTests } from "../../lib/storage.js";
import {
  createAccount,
  createAdmin,
  createArea,
  createFakeStorage,
  createFileAsset,
  createLandingRow,
  createStoryRow,
  createStudentProfile,
  createTestApp,
  createTutorProfile,
  fakeFileBytes,
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

    it("refuses a site image a block uses with 409 FILE_IN_USE", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const image = await createFileAsset(admin.id, "SITE_IMAGE", { contentType: "image/png" });
      await prisma.siteContent.create({
        data: { key: "seo", value: { title: "Masters Hub", description: "Tutors." } },
      });
      await prisma.siteContentFile.create({ data: { key: "seo", fileId: image.id } });

      const res = await app.inject({
        method: "DELETE",
        url: `${LIST_URL}/${image.id}`,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).code).toBe("FILE_IN_USE");
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

describe("POST /api/v1/admin/files/:id/remove", () => {
  const removeUrl = (id: string) => `${LIST_URL}/${id}/remove`;

  // A tutor with one ID submission. Decided submissions get the reviewer and, when rejected, a note.
  async function tutorIdSubmission(
    status: "PENDING" | "APPROVED" | "REJECTED",
    reviewerId: string,
    submittedAt?: Date,
  ) {
    const account = await createAccount({ role: "TUTOR" });
    const tutor = await createTutorProfile(account.id);
    const file = await createFileAsset(account.id, "TUTOR_ID", { originalName: "nid.jpg" });
    const verification = await prisma.tutorVerification.create({
      data: {
        tutorId: tutor.id,
        fileId: file.id,
        status,
        submittedAt,
        ...(status === "PENDING"
          ? {}
          : {
              reviewedById: reviewerId,
              decidedAt: new Date(),
              note: status === "REJECTED" ? "The photo is blurred" : null,
            }),
      },
    });
    return { account, tutor, file, verification };
  }

  async function studentIdSubmission(status: "PENDING" | "APPROVED", reviewerId: string) {
    const account = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    await createStudentProfile(account.id, area.id);
    const file = await createFileAsset(account.id, "STUDENT_ID", { originalName: "id.pdf" });
    await prisma.student.update({
      where: { accountId: account.id },
      data: {
        verificationFileId: file.id,
        verificationStatus: status,
        verificationSubmittedAt: new Date(),
        ...(status === "APPROVED"
          ? { verificationReviewedById: reviewerId, verificationDecidedAt: new Date() }
          : {}),
      },
    });
    return { account, file };
  }

  it("rejects a pending tutor ID, removes the stored copies and tells the tutor", async () => {
    const app = await createTestApp();
    const admin = await createAdmin({ status: "ACTIVE" });
    const { account, tutor, file, verification } = await tutorIdSubmission("PENDING", admin.id);
    const fake = createFakeStorage();
    setStorageForTests(fake.storage);
    fake.put(file.storageKey, fakeFileBytes("application/pdf", 1024), "application/pdf");
    fake.publicObjects.set(file.storageKey, {
      bytes: fakeFileBytes("application/pdf", 1024),
      contentType: "application/pdf",
    });

    const res = await app.inject({
      method: "POST",
      url: removeUrl(file.id),
      headers: await getAuthHeaders(admin),
      payload: { note: "The photo is blurred" },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      id: file.id,
      status: "DELETED",
      purpose: "TUTOR_ID",
      ownerEmail: account.email,
      inUse: true,
    });
    const row = await prisma.tutorVerification.findUniqueOrThrow({
      where: { id: verification.id },
    });
    expect(row).toMatchObject({
      status: "REJECTED",
      reviewedById: admin.id,
      note: "The photo is blurred",
      noteVisible: true,
    });
    const updatedTutor = await prisma.tutor.findUniqueOrThrow({ where: { id: tutor.id } });
    expect(updatedTutor.verificationStatus).toBe("REJECTED");
    expect(fake.objects.has(file.storageKey)).toBe(false);
    expect(fake.publicObjects.has(file.storageKey)).toBe(false);

    const reviews = await prisma.uploadReview.findMany({ where: { accountId: account.id } });
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      action: "REMOVED",
      purpose: "TUTOR_ID",
      fileId: file.id,
      fileName: "nid.jpg",
      note: "The photo is blurred",
      noteVisible: true,
      actorAccountId: admin.id,
    });
    const alerts = await prisma.appNotification.findMany({ where: { recipientId: account.id } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      kind: "FILE_REMOVED",
      note: "The photo is blurred",
      filePurpose: "TUTOR_ID",
    });
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: "file.remove", entityId: file.id },
    });
    expect(audit).toMatchObject({
      actorAccountId: admin.id,
      entityType: "file_asset",
      before: { status: "UPLOADED", purpose: "TUTOR_ID", ownerAccountId: account.id },
      after: {
        note: "The photo is blurred",
        noteVisible: true,
        unverify: false,
        verificationStatus: "REJECTED",
      },
    });
  });

  it("a hidden note stays off the tutor's alert and is kept for admins", async () => {
    const app = await createTestApp();
    const admin = await createAdmin({ status: "ACTIVE" });
    const { account, verification, file } = await tutorIdSubmission("PENDING", admin.id);

    const res = await app.inject({
      method: "POST",
      url: removeUrl(file.id),
      headers: await getAuthHeaders(admin),
      payload: { note: "Looks like a copy, check with the tutor", noteVisible: false },
    });

    expect(res.statusCode).toBe(200);
    const row = await prisma.tutorVerification.findUniqueOrThrow({
      where: { id: verification.id },
    });
    expect(row).toMatchObject({
      status: "REJECTED",
      note: "Looks like a copy, check with the tutor",
      noteVisible: false,
    });
    const review = await prisma.uploadReview.findFirstOrThrow({
      where: { accountId: account.id },
    });
    expect(review).toMatchObject({
      note: "Looks like a copy, check with the tutor",
      noteVisible: false,
    });
    const alert = await prisma.appNotification.findFirstOrThrow({
      where: { recipientId: account.id },
    });
    expect(alert).toMatchObject({ kind: "FILE_REMOVED", note: null });
  });

  it("an approved tutor ID stays approved without unverify and is rejected with it", async () => {
    const app = await createTestApp();
    const admin = await createAdmin({ status: "ACTIVE" });
    const headers = await getAuthHeaders(admin);
    const kept = await tutorIdSubmission("APPROVED", admin.id);
    const revoked = await tutorIdSubmission("APPROVED", admin.id);

    const keep = await app.inject({
      method: "POST",
      url: removeUrl(kept.file.id),
      headers,
      payload: { note: "File was replaced by mistake" },
    });
    expect(keep.statusCode).toBe(200);
    expect(JSON.parse(keep.body).status).toBe("DELETED");
    const keptRow = await prisma.tutorVerification.findUniqueOrThrow({
      where: { id: kept.verification.id },
    });
    expect(keptRow.status).toBe("APPROVED");
    const keptTutor = await prisma.tutor.findUniqueOrThrow({ where: { id: kept.tutor.id } });
    expect(keptTutor.verificationStatus).toBe("APPROVED");

    const revoke = await app.inject({
      method: "POST",
      url: removeUrl(revoked.file.id),
      headers,
      payload: { note: "The ID does not match the tutor", unverify: true },
    });
    expect(revoke.statusCode).toBe(200);
    const revokedRow = await prisma.tutorVerification.findUniqueOrThrow({
      where: { id: revoked.verification.id },
    });
    expect(revokedRow).toMatchObject({
      status: "REJECTED",
      note: "The ID does not match the tutor",
    });
    const revokedTutor = await prisma.tutor.findUniqueOrThrow({
      where: { id: revoked.tutor.id },
    });
    expect(revokedTutor.verificationStatus).toBe("REJECTED");
    const history = await prisma.uploadReview.findFirstOrThrow({
      where: { accountId: revoked.account.id },
    });
    expect(history.action).toBe("REMOVED");
  });

  it("only a tutor's latest submission changes; an older one using the file is left alone", async () => {
    const app = await createTestApp();
    const admin = await createAdmin({ status: "ACTIVE" });
    const account = await createAccount({ role: "TUTOR" });
    const tutor = await createTutorProfile(account.id);
    const oldFile = await createFileAsset(account.id, "TUTOR_ID");
    const newFile = await createFileAsset(account.id, "TUTOR_ID");
    const oldRow = await prisma.tutorVerification.create({
      data: {
        tutorId: tutor.id,
        fileId: oldFile.id,
        status: "APPROVED",
        submittedAt: new Date("2026-01-01T00:00:00Z"),
        reviewedById: admin.id,
        decidedAt: new Date("2026-01-02T00:00:00Z"),
      },
    });
    const newRow = await prisma.tutorVerification.create({
      data: {
        tutorId: tutor.id,
        fileId: newFile.id,
        status: "PENDING",
        submittedAt: new Date("2026-02-01T00:00:00Z"),
      },
    });

    const res = await app.inject({
      method: "POST",
      url: removeUrl(oldFile.id),
      headers: await getAuthHeaders(admin),
      payload: { note: "Old copy removed", unverify: true },
    });

    expect(res.statusCode).toBe(200);
    expect(
      (await prisma.tutorVerification.findUniqueOrThrow({ where: { id: oldRow.id } })).status,
    ).toBe("APPROVED");
    expect(
      (await prisma.tutorVerification.findUniqueOrThrow({ where: { id: newRow.id } })).status,
    ).toBe("PENDING");
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: "file.remove", entityId: oldFile.id },
    });
    expect(audit.after).toMatchObject({ verificationStatus: "APPROVED" });
  });

  it("rejects a pending student ID and keeps the file pointer the student record needs", async () => {
    const app = await createTestApp();
    const admin = await createAdmin({ status: "ACTIVE" });
    const { account, file } = await studentIdSubmission("PENDING", admin.id);

    const res = await app.inject({
      method: "POST",
      url: removeUrl(file.id),
      headers: await getAuthHeaders(admin),
      payload: { note: "The ID number is not visible" },
    });

    expect(res.statusCode).toBe(200);
    const student = await prisma.student.findUniqueOrThrow({ where: { accountId: account.id } });
    expect(student).toMatchObject({
      verificationStatus: "REJECTED",
      verificationReviewedById: admin.id,
      verificationNote: "The ID number is not visible",
      verificationNoteVisible: true,
      verificationFileId: file.id,
    });
    const alert = await prisma.appNotification.findFirstOrThrow({
      where: { recipientId: account.id },
    });
    expect(alert).toMatchObject({ kind: "FILE_REMOVED", filePurpose: "STUDENT_ID" });
  });

  it("an approved student ID stays approved without unverify and is rejected with it", async () => {
    const app = await createTestApp();
    const admin = await createAdmin({ status: "ACTIVE" });
    const headers = await getAuthHeaders(admin);
    const kept = await studentIdSubmission("APPROVED", admin.id);
    const revoked = await studentIdSubmission("APPROVED", admin.id);

    await app.inject({
      method: "POST",
      url: removeUrl(kept.file.id),
      headers,
      payload: { note: "File was replaced by mistake" },
    });
    await app.inject({
      method: "POST",
      url: removeUrl(revoked.file.id),
      headers,
      payload: { note: "The ID does not match the student", unverify: true },
    });

    const keptStudent = await prisma.student.findUniqueOrThrow({
      where: { accountId: kept.account.id },
    });
    expect(keptStudent.verificationStatus).toBe("APPROVED");
    const revokedStudent = await prisma.student.findUniqueOrThrow({
      where: { accountId: revoked.account.id },
    });
    expect(revokedStudent).toMatchObject({
      verificationStatus: "REJECTED",
      verificationNote: "The ID does not match the student",
    });
  });

  it("deletes the credential that uses the file", async () => {
    const app = await createTestApp();
    const admin = await createAdmin({ status: "ACTIVE" });
    const account = await createAccount({ role: "TUTOR" });
    const tutor = await createTutorProfile(account.id);
    const file = await createFileAsset(account.id, "CREDENTIAL", { originalName: "bsc.pdf" });
    await prisma.tutorCredential.create({
      data: { tutorId: tutor.id, examLabel: "BSc", result: "3.50", fileId: file.id },
    });

    const res = await app.inject({
      method: "POST",
      url: removeUrl(file.id),
      headers: await getAuthHeaders(admin),
      payload: { note: "Certificate is not readable" },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ status: "DELETED", inUse: false });
    expect(await prisma.tutorCredential.count({ where: { fileId: file.id } })).toBe(0);
    const alert = await prisma.appNotification.findFirstOrThrow({
      where: { recipientId: account.id },
    });
    expect(alert).toMatchObject({ kind: "FILE_REMOVED", filePurpose: "CREDENTIAL" });
  });

  it("deletes the video that uses the file and takes its public copy down", async () => {
    const app = await createTestApp();
    const admin = await createAdmin({ status: "ACTIVE" });
    const account = await createAccount({ role: "TUTOR" });
    const tutor = await createTutorProfile(account.id);
    const file = await createFileAsset(account.id, "TUTOR_VIDEO", {
      contentType: "video/mp4",
      originalName: "intro.mp4",
      publishedAt: new Date(),
    });
    await prisma.tutorVideo.create({
      data: { tutorId: tutor.id, fileId: file.id, title: "Intro", status: "APPROVED" },
    });
    const fake = createFakeStorage();
    setStorageForTests(fake.storage);
    fake.put(file.storageKey, fakeFileBytes("video/mp4", 1024), "video/mp4");
    fake.publicObjects.set(file.storageKey, {
      bytes: fakeFileBytes("video/mp4", 1024),
      contentType: "video/mp4",
    });

    const res = await app.inject({
      method: "POST",
      url: removeUrl(file.id),
      headers: await getAuthHeaders(admin),
      payload: { note: "Audio is not audible" },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ status: "DELETED", published: false });
    expect(await prisma.tutorVideo.count({ where: { fileId: file.id } })).toBe(0);
    expect(fake.objects.has(file.storageKey)).toBe(false);
    expect(fake.publicObjects.has(file.storageKey)).toBe(false);
    const review = await prisma.uploadReview.findFirstOrThrow({ where: { accountId: account.id } });
    expect(review).toMatchObject({ action: "REMOVED", purpose: "TUTOR_VIDEO" });
  });

  it("removes a file no record uses, with its objects, history and alert", async () => {
    const app = await createTestApp();
    const admin = await createAdmin({ status: "ACTIVE" });
    const owner = await createAccount({ role: "STUDENT" });
    const file = await createFileAsset(owner.id, "STUDENT_ID");
    const fake = createFakeStorage();
    setStorageForTests(fake.storage);
    fake.put(file.storageKey, fakeFileBytes("application/pdf", 1024), "application/pdf");

    const res = await app.inject({
      method: "POST",
      url: removeUrl(file.id),
      headers: await getAuthHeaders(admin),
      payload: { note: "Duplicate upload" },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ status: "DELETED", inUse: false });
    expect(fake.objects.has(file.storageKey)).toBe(false);
    const review = await prisma.uploadReview.findFirstOrThrow({ where: { accountId: owner.id } });
    expect(review).toMatchObject({ action: "REMOVED", note: "Duplicate upload", fileId: file.id });
    const alert = await prisma.appNotification.findFirstOrThrow({
      where: { recipientId: owner.id },
    });
    expect(alert).toMatchObject({ kind: "FILE_REMOVED", note: "Duplicate upload" });
  });

  it("refuses a site image or video with 400 and points to Site content", async () => {
    const app = await createTestApp();
    const admin = await createAdmin({ status: "ACTIVE" });
    const headers = await getAuthHeaders(admin);

    for (const purpose of ["SITE_IMAGE", "SITE_VIDEO"] as const) {
      const file = await createFileAsset(admin.id, purpose, {
        contentType: purpose === "SITE_IMAGE" ? "image/png" : "video/mp4",
      });

      const res = await app.inject({
        method: "POST",
        url: removeUrl(file.id),
        headers,
        payload: { note: "Replace it with a new one" },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toMatchObject({
        code: "INVALID_FILE",
        message: "Replace this file in Site content first.",
      });
      const row = await prisma.fileAsset.findUniqueOrThrow({ where: { id: file.id } });
      expect(row.status).toBe("UPLOADED");
    }
    expect(await prisma.uploadReview.count()).toBe(0);
  });

  it("answers 404 for unknown and already removed files, 400 for a blog cover, 400 for a short note, 403 for non-admins", async () => {
    const app = await createTestApp();
    const admin = await createAdmin({ status: "ACTIVE" });
    const headers = await getAuthHeaders(admin);
    const owner = await createAccount({ role: "STUDENT" });
    const removed = await createFileAsset(owner.id, "STUDENT_ID", { status: "DELETED" });
    const cover = await createFileAsset(admin.id, "BLOG_COVER");
    const live = await createFileAsset(owner.id, "STUDENT_ID");

    const unknown = await app.inject({
      method: "POST",
      url: removeUrl(crypto.randomUUID()),
      headers,
      payload: { note: "Duplicate upload" },
    });
    expect(unknown.statusCode).toBe(404);

    const gone = await app.inject({
      method: "POST",
      url: removeUrl(removed.id),
      headers,
      payload: { note: "Duplicate upload" },
    });
    expect(gone.statusCode).toBe(404);

    const blogCover = await app.inject({
      method: "POST",
      url: removeUrl(cover.id),
      headers,
      payload: { note: "Replace the cover" },
    });
    expect(blogCover.statusCode).toBe(400);
    expect(JSON.parse(blogCover.body).code).toBe("INVALID_FILE");
    expect((await prisma.fileAsset.findUniqueOrThrow({ where: { id: cover.id } })).status).toBe(
      "UPLOADED",
    );

    const shortNote = await app.inject({
      method: "POST",
      url: removeUrl(live.id),
      headers,
      payload: { note: "ok" },
    });
    expect(shortNote.statusCode).toBe(400);

    const denied = await app.inject({
      method: "POST",
      url: removeUrl(live.id),
      headers: await getAuthHeaders(owner),
      payload: { note: "Duplicate upload" },
    });
    expect(denied.statusCode).toBe(403);

    expect(await prisma.uploadReview.count()).toBe(0);
    expect((await prisma.fileAsset.findUniqueOrThrow({ where: { id: live.id } })).status).toBe(
      "UPLOADED",
    );
  });
});

describe("removing a story or tutor video file", () => {
  const removeUrl = (id: string) => `/api/v1/admin/files/${id}/remove`;
  const landing = { note: "Not something we can show.", noteVisible: true };

  it("removes the story with its card and its other file, and alerts the author", async () => {
    const app = await createTestApp();
    const admin = await createAdmin({ status: "ACTIVE" });
    const student = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    await createStudentProfile(student.id, area.id);
    const photo = await createFileAsset(student.id, "STORY_IMAGE", { contentType: "image/png" });
    const clip = await createFileAsset(student.id, "STORY_VIDEO", { contentType: "video/mp4" });
    const story = await createStoryRow(student.id, {
      status: "APPROVED",
      imageFileId: photo.id,
      videoFileId: clip.id,
    });
    await createLandingRow("testimonials", [
      {
        name: "Ana",
        role: "Student",
        photo: `file:${photo.id}`,
        quote: "Great help",
        comment: "Clear lessons every week",
        source: { kind: "story", id: story.id },
      },
    ]);

    const res = await app.inject({
      method: "POST",
      url: removeUrl(photo.id),
      headers: await getAuthHeaders(admin),
      payload: landing,
    });

    expect(res.statusCode).toBe(200);
    expect(await prisma.story.count({ where: { id: story.id } })).toBe(0);
    expect(await prisma.siteContent.count({ where: { key: "testimonials" } })).toBe(0);
    expect((await prisma.fileAsset.findUniqueOrThrow({ where: { id: clip.id } })).status).toBe(
      "DELETED",
    );
    const alert = await prisma.appNotification.findFirstOrThrow({
      where: { recipientId: student.id, kind: "FILE_REMOVED" },
    });
    expect(alert.filePurpose).toBe("STORY_IMAGE");
    expect(alert.note).toBe(landing.note);
  });

  it("removes a tutor video from the landing page and deletes it", async () => {
    const app = await createTestApp();
    const admin = await createAdmin({ status: "ACTIVE" });
    const account = await createAccount({ role: "TUTOR" });
    const tutor = await createTutorProfile(account.id);
    const file = await createFileAsset(account.id, "TUTOR_VIDEO", { contentType: "video/mp4" });
    const video = await prisma.tutorVideo.create({
      data: {
        tutorId: tutor.id,
        fileId: file.id,
        title: "Algebra",
        status: "APPROVED",
        landingConsentAt: new Date(),
      },
    });
    await createLandingRow("showcase", [
      {
        kind: "video",
        name: "Rafi",
        subject: "Maths",
        thumbnail: "/assets/showcase/one.png",
        video: `file:${file.id}`,
        source: { kind: "tutor_video", id: video.id },
      },
    ]);

    const res = await app.inject({
      method: "POST",
      url: removeUrl(file.id),
      headers: await getAuthHeaders(admin),
      payload: landing,
    });

    expect(res.statusCode).toBe(200);
    expect(await prisma.tutorVideo.count({ where: { id: video.id } })).toBe(0);
    expect(await prisma.siteContent.count({ where: { key: "showcase" } })).toBe(0);
  });
});
