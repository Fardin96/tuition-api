import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { prisma } from "../../lib/prisma.js";
import {
  createAccount,
  createAdmin,
  createArea,
  createFileAsset,
  createStudentProfile,
  createTestApp,
  createTutorProfile,
  getAuthHeaders,
} from "../../tests/helpers.js";

const BASE = "/api/v1/admin/verifications";

// A tutor with an ID submission waiting. The insert fires tutor_verification_sync.
// Decided rows need decidedAt and reviewedBy (tv_decision_shape), so they get a reviewer.
async function submitTutorId(
  submittedAt: Date,
  status: "PENDING" | "APPROVED" | "REJECTED" = "PENDING",
) {
  const account = await createAccount({ role: "TUTOR" });
  const tutor = await createTutorProfile(account.id, { studentIdNumber: "TUT-1" });
  const file = await createFileAsset(account.id, "TUTOR_ID");
  const decided = status !== "PENDING";
  const reviewer = decided ? await createAdmin({ status: "ACTIVE" }) : null;
  const verification = await prisma.tutorVerification.create({
    data: {
      tutorId: tutor.id,
      fileId: file.id,
      status,
      submittedAt,
      decidedAt: decided ? submittedAt : null,
      reviewedById: reviewer?.id ?? null,
      note: status === "REJECTED" ? "Blurry photo" : null,
    },
  });
  return { account, tutor, file, verification };
}

// A second submission for a tutor who already has one.
async function addTutorSubmission(tutorId: string, submittedAt: Date) {
  const file = await createFileAsset(
    (await prisma.tutor.findUniqueOrThrow({ where: { id: tutorId } })).accountId,
    "TUTOR_ID",
  );
  return prisma.tutorVerification.create({
    data: { tutorId, fileId: file.id, submittedAt },
  });
}

async function submitStudentId(submittedAt: Date) {
  const account = await createAccount({ role: "STUDENT" });
  const area = await createArea();
  const student = await createStudentProfile(account.id, area.id);
  const file = await createFileAsset(account.id, "STUDENT_ID");
  await prisma.student.update({
    where: { id: student.id },
    data: {
      verificationStatus: "PENDING",
      verificationFileId: file.id,
      verificationSubmittedAt: submittedAt,
    },
  });
  return { account, student, file };
}

// History and alerts for one account, oldest first.
function historyFor(accountId: string) {
  return prisma.uploadReview.findMany({
    where: { accountId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

function alertsFor(accountId: string) {
  return prisma.appNotification.findMany({
    where: { recipientId: accountId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

describe("admin ID verifications", () => {
  describe("GET /tutors", () => {
    it("rejects non-admins with 403 and anonymous calls with 401", async () => {
      const app = await createTestApp();
      const tutor = await createAccount({ role: "TUTOR" });

      const anon = await app.inject({ method: "GET", url: `${BASE}/tutors` });
      expect(anon.statusCode).toBe(401);

      const res = await app.inject({
        method: "GET",
        url: `${BASE}/tutors`,
        headers: await getAuthHeaders(tutor),
      });
      expect(res.statusCode).toBe(403);
    });

    it("lists PENDING oldest first by default and pages with nextCursor", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const newest = await submitTutorId(new Date("2026-05-03T00:00:00Z"));
      const oldest = await submitTutorId(new Date("2026-05-01T00:00:00Z"));
      const middle = await submitTutorId(new Date("2026-05-02T00:00:00Z"));
      await submitTutorId(new Date("2026-05-01T00:00:00Z"), "APPROVED");
      const headers = await getAuthHeaders(admin);

      const page1 = await app.inject({
        method: "GET",
        url: `${BASE}/tutors?limit=2`,
        headers,
      });
      expect(page1.statusCode).toBe(200);
      const body1 = JSON.parse(page1.body);
      expect(body1.verifications.map((v: { id: string }) => v.id)).toEqual([
        oldest.verification.id,
        middle.verification.id,
      ]);
      expect(body1.nextCursor).toEqual(expect.any(String));
      expect(body1.verifications[0]).toMatchObject({
        status: "PENDING",
        note: null,
        noteVisible: true,
        reviewedById: null,
        isLatest: true,
        uploadFlags: { recentIssues: 0, uploadsBlocked: false },
        file: { id: oldest.file.id, purpose: "TUTOR_ID" },
        tutor: { id: oldest.tutor.id, name: "Test Tutor", studentIdNumber: "TUT-1" },
      });

      const page2 = await app.inject({
        method: "GET",
        url: `${BASE}/tutors?limit=2&cursor=${encodeURIComponent(body1.nextCursor)}`,
        headers,
      });
      const body2 = JSON.parse(page2.body);
      expect(body2.verifications.map((v: { id: string }) => v.id)).toEqual([
        newest.verification.id,
      ]);
      expect(body2.nextCursor).toBeNull();
    });

    it("lists APPROVED newest first", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const older = await submitTutorId(new Date("2026-04-01T00:00:00Z"), "APPROVED");
      const newer = await submitTutorId(new Date("2026-04-02T00:00:00Z"), "APPROVED");

      const res = await app.inject({
        method: "GET",
        url: `${BASE}/tutors?status=APPROVED`,
        headers: await getAuthHeaders(admin),
      });

      expect(JSON.parse(res.body).verifications.map((v: { id: string }) => v.id)).toEqual([
        newer.verification.id,
        older.verification.id,
      ]);
    });

    it("marks only the tutor's newest submission as isLatest", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      // Only one PENDING submission per tutor is allowed, so the older one is already decided.
      const { tutor, verification: older } = await submitTutorId(
        new Date("2026-05-01T00:00:00Z"),
        "REJECTED",
      );
      const newer = await addTutorSubmission(tutor.id, new Date("2026-05-02T00:00:00Z"));

      const res = await app.inject({
        method: "GET",
        url: `${BASE}/tutors`,
        headers: await getAuthHeaders(admin),
      });

      // The default list is PENDING; the older (decided) submission is in the REJECTED list.
      const rejected = await app.inject({
        method: "GET",
        url: `${BASE}/tutors?status=REJECTED`,
        headers: await getAuthHeaders(admin),
      });
      expect(JSON.parse(rejected.body).verifications[0]).toMatchObject({
        id: older.id,
        isLatest: false,
      });
      const pending = JSON.parse(res.body).verifications as { id: string; isLatest: boolean }[];
      expect(pending.find((v) => v.id === newer.id)?.isLatest).toBe(true);
    });
  });

  describe("POST /tutors/:id/decide", () => {
    it("approve sets APPROVED on the submission and the tutor (trigger)", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const { tutor, verification } = await submitTutorId(new Date());

      const res = await app.inject({
        method: "POST",
        url: `${BASE}/tutors/${verification.id}/decide`,
        headers: await getAuthHeaders(admin),
        payload: { decision: "APPROVE" },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({
        id: verification.id,
        status: "APPROVED",
        note: null,
        noteVisible: true,
        reviewedById: admin.id,
        decidedAt: expect.any(String),
        isLatest: true,
        uploadFlags: { recentIssues: 0, uploadsBlocked: false },
        tutor: { id: tutor.id, verificationStatus: "APPROVED" },
      });
      const updated = await prisma.tutor.findUniqueOrThrow({ where: { id: tutor.id } });
      expect(updated.verificationStatus).toBe("APPROVED");
    });

    it("rejects without a note with 400", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const { verification } = await submitTutorId(new Date());

      const res = await app.inject({
        method: "POST",
        url: `${BASE}/tutors/${verification.id}/decide`,
        headers: await getAuthHeaders(admin),
        payload: { decision: "REJECT" },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe("VALIDATION_ERROR");
      const row = await prisma.tutorVerification.findUniqueOrThrow({
        where: { id: verification.id },
      });
      expect(row.status).toBe("PENDING");
    });

    it("rejects unknown fields with 400", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const { verification } = await submitTutorId(new Date());

      const res = await app.inject({
        method: "POST",
        url: `${BASE}/tutors/${verification.id}/decide`,
        headers: await getAuthHeaders(admin),
        payload: { decision: "APPROVE", status: "REJECTED" },
      });

      expect(res.statusCode).toBe(400);
    });

    it("reject with a note stores the note and sets the tutor REJECTED", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const { tutor, verification } = await submitTutorId(new Date());

      const res = await app.inject({
        method: "POST",
        url: `${BASE}/tutors/${verification.id}/decide`,
        headers: await getAuthHeaders(admin),
        payload: { decision: "REJECT", note: "  The ID photo is blurry  " },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({
        status: "REJECTED",
        note: "The ID photo is blurry",
      });
      const updated = await prisma.tutor.findUniqueOrThrow({ where: { id: tutor.id } });
      expect(updated.verificationStatus).toBe("REJECTED");
    });

    it("repeating the same decision gets 409 INVALID_VERIFICATION_STATE", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const { account, verification } = await submitTutorId(new Date());
      const headers = await getAuthHeaders(admin);
      const url = `${BASE}/tutors/${verification.id}/decide`;

      const first = await app.inject({
        method: "POST",
        url,
        headers,
        payload: { decision: "APPROVE" },
      });
      expect(first.statusCode).toBe(200);

      const second = await app.inject({
        method: "POST",
        url,
        headers,
        payload: { decision: "APPROVE" },
      });

      expect(second.statusCode).toBe(409);
      expect(JSON.parse(second.body)).toMatchObject({
        code: "INVALID_VERIFICATION_STATE",
        message: "This submission already has that decision.",
      });
      const row = await prisma.tutorVerification.findUniqueOrThrow({
        where: { id: verification.id },
      });
      expect(row.status).toBe("APPROVED");
      expect(await historyFor(account.id)).toHaveLength(1);
    });

    it("a rejected ID can be approved, and an approved ID can be rejected again (revocation)", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const { account, tutor, verification } = await submitTutorId(new Date());
      const headers = await getAuthHeaders(admin);
      const url = `${BASE}/tutors/${verification.id}/decide`;

      const rejected = await app.inject({
        method: "POST",
        url,
        headers,
        payload: { decision: "REJECT", note: "Name does not match" },
      });
      expect(rejected.statusCode).toBe(200);

      const approved = await app.inject({
        method: "POST",
        url,
        headers,
        payload: { decision: "APPROVE" },
      });
      expect(approved.statusCode).toBe(200);
      expect(JSON.parse(approved.body)).toMatchObject({ status: "APPROVED", note: null });
      expect(
        (await prisma.tutor.findUniqueOrThrow({ where: { id: tutor.id } })).verificationStatus,
      ).toBe("APPROVED");

      const revoked = await app.inject({
        method: "POST",
        url,
        headers,
        payload: { decision: "REJECT", note: "The ID has expired" },
      });
      expect(revoked.statusCode).toBe(200);
      expect(
        (await prisma.tutor.findUniqueOrThrow({ where: { id: tutor.id } })).verificationStatus,
      ).toBe("REJECTED");

      const history = await historyFor(account.id);
      expect(history.map((h) => h.action)).toEqual(["REJECTED", "APPROVED", "REVOKED"]);
      expect(history[2]).toMatchObject({ note: "The ID has expired", fileId: verification.fileId });
    });

    it("only the tutor's newest submission can be decided", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      // Only one PENDING submission per tutor is allowed, so the older one is already decided.
      const older = await submitTutorId(new Date("2026-05-01T00:00:00Z"), "REJECTED");
      const newer = await addTutorSubmission(older.tutor.id, new Date("2026-05-02T00:00:00Z"));
      const headers = await getAuthHeaders(admin);

      const stale = await app.inject({
        method: "POST",
        url: `${BASE}/tutors/${older.verification.id}/decide`,
        headers,
        payload: { decision: "APPROVE" },
      });
      expect(stale.statusCode).toBe(409);
      expect(JSON.parse(stale.body)).toMatchObject({
        code: "INVALID_VERIFICATION_STATE",
        message: "Only the latest submission can be changed.",
      });
      expect(
        (await prisma.tutorVerification.findUniqueOrThrow({ where: { id: older.verification.id } }))
          .status,
      ).toBe("REJECTED");

      const current = await app.inject({
        method: "POST",
        url: `${BASE}/tutors/${newer.id}/decide`,
        headers,
        payload: { decision: "APPROVE" },
      });
      expect(current.statusCode).toBe(200);
    });

    it("approve fails with 409 when the file was removed; reject still works", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const { account, verification, file } = await submitTutorId(new Date());
      await prisma.fileAsset.update({
        where: { id: file.id },
        data: { status: "DELETED", deletedAt: new Date() },
      });
      const headers = await getAuthHeaders(admin);
      const url = `${BASE}/tutors/${verification.id}/decide`;

      const approve = await app.inject({
        method: "POST",
        url,
        headers,
        payload: { decision: "APPROVE" },
      });
      expect(approve.statusCode).toBe(409);
      expect(JSON.parse(approve.body)).toMatchObject({
        code: "INVALID_VERIFICATION_STATE",
        message: "The file was removed. Ask for a new upload.",
      });
      expect(
        (await prisma.tutorVerification.findUniqueOrThrow({ where: { id: verification.id } }))
          .status,
      ).toBe("PENDING");
      expect(await historyFor(account.id)).toHaveLength(0);

      const reject = await app.inject({
        method: "POST",
        url,
        headers,
        payload: { decision: "REJECT", note: "The file was removed" },
      });
      expect(reject.statusCode).toBe(200);
    });

    it("keeps a hidden note for admins and hides it from the tutor's alert", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const { account, verification } = await submitTutorId(new Date());

      const res = await app.inject({
        method: "POST",
        url: `${BASE}/tutors/${verification.id}/decide`,
        headers: await getAuthHeaders(admin),
        payload: { decision: "REJECT", note: "Looks like a forgery", noteVisible: false },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({
        note: "Looks like a forgery",
        noteVisible: false,
      });
      const row = await prisma.tutorVerification.findUniqueOrThrow({
        where: { id: verification.id },
      });
      expect(row.noteVisible).toBe(false);

      const [alert] = await alertsFor(account.id);
      expect(alert).toMatchObject({ kind: "ID_REJECTED", note: null });
      const [history] = await historyFor(account.id);
      expect(history).toMatchObject({
        action: "REJECTED",
        note: "Looks like a forgery",
        noteVisible: false,
      });
    });

    it("writes one history row and one alert per decision", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const { account, verification, file } = await submitTutorId(new Date());

      const res = await app.inject({
        method: "POST",
        url: `${BASE}/tutors/${verification.id}/decide`,
        headers: await getAuthHeaders(admin),
        payload: { decision: "APPROVE", note: "Thanks, all good" },
      });
      expect(res.statusCode).toBe(200);

      const history = await historyFor(account.id);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        action: "APPROVED",
        fileId: file.id,
        purpose: "TUTOR_ID",
        note: "Thanks, all good",
        noteVisible: true,
        actorAccountId: admin.id,
      });

      const alerts = await alertsFor(account.id);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({ kind: "ID_APPROVED", note: "Thanks, all good" });
    });

    it("counts recent issues and an active block in uploadFlags", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const { account, verification } = await submitTutorId(new Date());
      const issue = (action: "REJECTED" | "REVOKED" | "REMOVED", createdAt = new Date()) =>
        prisma.uploadReview.create({
          data: {
            accountId: account.id,
            action,
            purpose: "TUTOR_ID" as const,
            note: "Earlier problem",
            actorAccountId: admin.id,
            createdAt,
          },
        });
      await issue("REJECTED");
      await issue("REVOKED");
      await issue("REMOVED");
      // Older than 30 days, and not an issue action: neither counts.
      await issue("REJECTED", new Date(Date.now() - 40 * 24 * 60 * 60 * 1000));
      await prisma.uploadReview.create({
        data: {
          accountId: account.id,
          action: "APPROVED",
          purpose: "TUTOR_ID",
          actorAccountId: admin.id,
        },
      });
      const headers = await getAuthHeaders(admin);

      const before = await app.inject({
        method: "GET",
        url: `${BASE}/tutors`,
        headers,
      });
      expect(JSON.parse(before.body).verifications[0].uploadFlags).toEqual({
        recentIssues: 3,
        uploadsBlocked: false,
      });

      await prisma.uploadBlock.create({
        data: {
          accountId: account.id,
          blocksVideos: false,
          blocksDocuments: true,
          note: "Paused for review",
          blockedById: admin.id,
        },
      });
      const res = await app.inject({
        method: "POST",
        url: `${BASE}/tutors/${verification.id}/decide`,
        headers,
        payload: { decision: "APPROVE" },
      });
      expect(JSON.parse(res.body).uploadFlags).toEqual({ recentIssues: 3, uploadsBlocked: true });
    });

    it("returns 404 for an unknown id", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });

      const res = await app.inject({
        method: "POST",
        url: `${BASE}/tutors/${crypto.randomUUID()}/decide`,
        headers: await getAuthHeaders(admin),
        payload: { decision: "APPROVE" },
      });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).code).toBe("NOT_FOUND");
    });

    it("writes an audit row with the before and after state", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const { verification } = await submitTutorId(new Date());

      const res = await app.inject({
        method: "POST",
        url: `${BASE}/tutors/${verification.id}/decide`,
        headers: await getAuthHeaders(admin),
        payload: { decision: "REJECT", note: "Not a valid ID" },
      });
      expect(res.statusCode).toBe(200);

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { entityType: "tutor_verification", entityId: verification.id },
      });
      expect(audit.action).toBe("verification.decide");
      expect(audit.actorAccountId).toBe(admin.id);
      expect(audit.before).toEqual({ status: "PENDING" });
      expect(audit.after).toEqual({
        status: "REJECTED",
        note: "Not a valid ID",
        noteVisible: true,
      });
    });
  });

  describe("student IDs", () => {
    it("GET /students lists PENDING submissions with the student's file", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const pending = await submitStudentId(new Date("2026-06-01T00:00:00Z"));
      await submitStudentId(new Date("2026-06-02T00:00:00Z"));

      const res = await app.inject({
        method: "GET",
        url: `${BASE}/students?limit=1`,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.verifications).toHaveLength(1);
      expect(body.verifications[0]).toMatchObject({
        studentId: pending.student.id,
        status: "PENDING",
        noteVisible: true,
        uploadFlags: { recentIssues: 0, uploadsBlocked: false },
        file: { id: pending.file.id, purpose: "STUDENT_ID" },
        student: { id: pending.student.id, name: "Test Student" },
      });
      expect(body.nextCursor).toEqual(expect.any(String));
    });

    it("approve updates the student columns and writes an audit row", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const { student } = await submitStudentId(new Date());

      const res = await app.inject({
        method: "POST",
        url: `${BASE}/students/${student.id}/decide`,
        headers: await getAuthHeaders(admin),
        payload: { decision: "APPROVE" },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({
        studentId: student.id,
        status: "APPROVED",
        noteVisible: true,
        reviewedById: admin.id,
      });
      const row = await prisma.student.findUniqueOrThrow({ where: { id: student.id } });
      expect(row.verificationStatus).toBe("APPROVED");
      expect(row.verificationDecidedAt).not.toBeNull();
      expect(row.verificationReviewedById).toBe(admin.id);

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { entityType: "student", entityId: student.id, action: "verification.decide" },
      });
      expect(audit.before).toEqual({ status: "PENDING" });
      expect(audit.after).toEqual({ status: "APPROVED", note: null, noteVisible: true });
    });

    it("reject needs a note, then stores it; repeating the decision gets 409", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const { student } = await submitStudentId(new Date());
      const headers = await getAuthHeaders(admin);
      const url = `${BASE}/students/${student.id}/decide`;

      const noNote = await app.inject({
        method: "POST",
        url,
        headers,
        payload: { decision: "REJECT" },
      });
      expect(noNote.statusCode).toBe(400);

      const rejected = await app.inject({
        method: "POST",
        url,
        headers,
        payload: { decision: "REJECT", note: "Name does not match" },
      });
      expect(rejected.statusCode).toBe(200);
      const row = await prisma.student.findUniqueOrThrow({ where: { id: student.id } });
      expect(row.verificationStatus).toBe("REJECTED");
      expect(row.verificationNote).toBe("Name does not match");

      const again = await app.inject({
        method: "POST",
        url,
        headers,
        payload: { decision: "REJECT", note: "Still does not match" },
      });
      expect(again.statusCode).toBe(409);
      expect(JSON.parse(again.body).code).toBe("INVALID_VERIFICATION_STATE");
    });

    it("a rejected student can be approved, and an approved one revoked", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const { account, student } = await submitStudentId(new Date());
      const headers = await getAuthHeaders(admin);
      const url = `${BASE}/students/${student.id}/decide`;

      await app.inject({
        method: "POST",
        url,
        headers,
        payload: { decision: "REJECT", note: "Blurry" },
      });
      const approved = await app.inject({
        method: "POST",
        url,
        headers,
        payload: { decision: "APPROVE" },
      });
      expect(approved.statusCode).toBe(200);
      expect(JSON.parse(approved.body)).toMatchObject({ status: "APPROVED", note: null });

      const revoked = await app.inject({
        method: "POST",
        url,
        headers,
        payload: { decision: "REJECT", note: "Card has expired" },
      });
      expect(revoked.statusCode).toBe(200);
      expect(
        (await prisma.student.findUniqueOrThrow({ where: { id: student.id } })).verificationStatus,
      ).toBe("REJECTED");

      const history = await historyFor(account.id);
      expect(history.map((h) => h.action)).toEqual(["REJECTED", "APPROVED", "REVOKED"]);
    });

    it("a student with no submission gets 409", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const account = await createAccount({ role: "STUDENT" });
      const area = await createArea();
      const student = await createStudentProfile(account.id, area.id);

      const res = await app.inject({
        method: "POST",
        url: `${BASE}/students/${student.id}/decide`,
        headers: await getAuthHeaders(admin),
        payload: { decision: "APPROVE" },
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).code).toBe("INVALID_VERIFICATION_STATE");
    });

    it("approve with a removed file gets 409", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const { student, file } = await submitStudentId(new Date());
      await prisma.fileAsset.update({
        where: { id: file.id },
        data: { status: "DELETED", deletedAt: new Date() },
      });

      const res = await app.inject({
        method: "POST",
        url: `${BASE}/students/${student.id}/decide`,
        headers: await getAuthHeaders(admin),
        payload: { decision: "APPROVE" },
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).message).toBe("The file was removed. Ask for a new upload.");
      expect(
        (await prisma.student.findUniqueOrThrow({ where: { id: student.id } })).verificationStatus,
      ).toBe("PENDING");
    });

    it("keeps a hidden note for admins and hides it from the student's alert", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const { account, student } = await submitStudentId(new Date());

      const res = await app.inject({
        method: "POST",
        url: `${BASE}/students/${student.id}/decide`,
        headers: await getAuthHeaders(admin),
        payload: { decision: "REJECT", note: "Duplicate of another account", noteVisible: false },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({
        note: "Duplicate of another account",
        noteVisible: false,
      });
      expect(
        (await prisma.student.findUniqueOrThrow({ where: { id: student.id } }))
          .verificationNoteVisible,
      ).toBe(false);
      const alerts = await alertsFor(account.id);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({ kind: "ID_REJECTED", note: null });
      expect(await historyFor(account.id)).toHaveLength(1);
    });
  });
});
