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
        reviewedById: null,
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
        reviewedById: admin.id,
        decidedAt: expect.any(String),
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

    it("a second decision gets 409 INVALID_VERIFICATION_STATE", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const { verification } = await submitTutorId(new Date());
      const headers = await getAuthHeaders(admin);

      const first = await app.inject({
        method: "POST",
        url: `${BASE}/tutors/${verification.id}/decide`,
        headers,
        payload: { decision: "APPROVE" },
      });
      expect(first.statusCode).toBe(200);

      const second = await app.inject({
        method: "POST",
        url: `${BASE}/tutors/${verification.id}/decide`,
        headers,
        payload: { decision: "REJECT", note: "Changed my mind" },
      });

      expect(second.statusCode).toBe(409);
      expect(JSON.parse(second.body).code).toBe("INVALID_VERIFICATION_STATE");
      const row = await prisma.tutorVerification.findUniqueOrThrow({
        where: { id: verification.id },
      });
      expect(row.status).toBe("APPROVED");
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
      expect(audit.after).toEqual({ status: "REJECTED", note: "Not a valid ID" });
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
      expect(audit.after).toEqual({ status: "APPROVED", note: null });
    });

    it("reject needs a note, then stores it; a second decision gets 409", async () => {
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
        payload: { decision: "APPROVE" },
      });
      expect(again.statusCode).toBe(409);
      expect(JSON.parse(again.body).code).toBe("INVALID_VERIFICATION_STATE");
    });
  });
});
