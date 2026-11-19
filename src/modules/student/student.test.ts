import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { prisma } from "../../lib/prisma.js";
import { setStorageForTests } from "../../lib/storage.js";
import {
  createAccount,
  createApplication,
  createArea,
  createFakeStorage,
  createFileAsset,
  createRequirement,
  createStudentProfile,
  createSubject,
  createTestApp,
  createTutorProfile,
  getAuthHeaders,
} from "../../tests/helpers.js";
import { createStudentProfile as createStudentProfileService } from "./student.service.js";

function phone() {
  return `+88017${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
}

function studentPayload(areaId: number) {
  return {
    name: "Student Name",
    areaId,
    address: "Student Address",
    emergencyContact: "+8801700000001",
    phoneNumber: phone(),
    whatsappNumber: phone(),
    studentIdNumber: `STU-${crypto.randomUUID()}`,
  };
}

describe("student routes", () => {
  describe("POST /api/v1/students/me", () => {
    it("creates a student profile", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "STUDENT" });
      const area = await createArea();
      const headers = await getAuthHeaders(account);

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/students/me",
        headers,
        payload: studentPayload(area.id),
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.name).toBe("Student Name");
      expect(body.areaId).toBe(area.id);
      expect(body.verificationStatus).toBe("NOT_SUBMITTED");
    });

    it("creates profiles without a WhatsApp number", async () => {
      const app = await createTestApp();
      const area = await createArea();
      const { whatsappNumber: _whatsapp, ...payload } = studentPayload(area.id);

      const first = await createAccount({ role: "STUDENT" });
      const second = await createAccount({ role: "STUDENT" });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/students/me",
        headers: await getAuthHeaders(first),
        payload,
      });
      const other = await app.inject({
        method: "POST",
        url: "/api/v1/students/me",
        headers: await getAuthHeaders(second),
        payload: { ...payload, phoneNumber: phone() },
      });

      expect(res.statusCode).toBe(201);
      expect(JSON.parse(res.body).whatsappNumber).toBeNull();
      expect(other.statusCode).toBe(201);
    });

    it("rejects a profile without a phone number", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "STUDENT" });
      const area = await createArea();
      const { phoneNumber: _phone, ...payload } = studentPayload(area.id);

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/students/me",
        headers: await getAuthHeaders(account),
        payload,
      });

      expect(res.statusCode).toBe(400);
    });

    it("rejects non-student accounts", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      const area = await createArea();
      const headers = await getAuthHeaders(account);

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/students/me",
        headers,
        payload: studentPayload(area.id),
      });

      expect(res.statusCode).toBe(403);
    });

    it("rejects duplicate profiles", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "STUDENT" });
      const area = await createArea();
      const headers = await getAuthHeaders(account);
      const payload = studentPayload(area.id);

      await app.inject({ method: "POST", url: "/api/v1/students/me", headers, payload });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/students/me",
        headers,
        payload,
      });

      expect(res.statusCode).toBe(409);
    });

    it("rejects an inactive area with a ValidationError (400)", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "STUDENT" });
      const inactive = await createArea({ isActive: false });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/students/me",
        headers: await getAuthHeaders(account),
        payload: studentPayload(inactive.id),
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe("VALIDATION_ERROR");
      expect(await prisma.student.count({ where: { accountId: account.id } })).toBe(0);
    });

    it("rejects an unknown area id with a ValidationError (400)", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "STUDENT" });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/students/me",
        headers: await getAuthHeaders(account),
        payload: studentPayload(999999),
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe("VALIDATION_ERROR");
    });

    it("rejects a WhatsApp number starting with the reserved deleted: prefix", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "STUDENT" });
      const area = await createArea();
      const headers = await getAuthHeaders(account);

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/students/me",
        headers,
        payload: { ...studentPayload(area.id), whatsappNumber: "deleted:abc" },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe("PATCH /api/v1/students/me", () => {
    it("updates the profile", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "STUDENT" });
      const area = await createArea();
      await createStudentProfile(account.id, area.id);
      const headers = await getAuthHeaders(account);

      const res = await app.inject({
        method: "PATCH",
        url: "/api/v1/students/me",
        headers,
        payload: { name: "Updated Name" },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).name).toBe("Updated Name");
    });

    it("clears the WhatsApp number and its verification when set to null", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "STUDENT" });
      const area = await createArea();
      await createStudentProfile(account.id, area.id, { whatsappNumber: phone() });
      await prisma.student.update({
        where: { accountId: account.id },
        data: { whatsappVerifiedAt: new Date() },
      });

      const res = await app.inject({
        method: "PATCH",
        url: "/api/v1/students/me",
        headers: await getAuthHeaders(account),
        payload: { whatsappNumber: null },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).whatsappNumber).toBeNull();
      expect(JSON.parse(res.body).whatsappVerifiedAt).toBeNull();
      const saved = await prisma.student.findUniqueOrThrow({ where: { accountId: account.id } });
      expect(saved.whatsappNumber).toBeNull();
    });

    it("rejects changing to an inactive area (400)", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "STUDENT" });
      const area = await createArea();
      const inactive = await createArea({ isActive: false });
      await createStudentProfile(account.id, area.id);

      const res = await app.inject({
        method: "PATCH",
        url: "/api/v1/students/me",
        headers: await getAuthHeaders(account),
        payload: { areaId: inactive.id },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe("VALIDATION_ERROR");
      const saved = await prisma.student.findUniqueOrThrow({ where: { accountId: account.id } });
      expect(saved.areaId).toBe(area.id);
    });

    it("keeps an area that was deactivated while the student still has it", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "STUDENT" });
      const area = await createArea();
      await createStudentProfile(account.id, area.id);
      await prisma.area.update({ where: { id: area.id }, data: { isActive: false } });

      const res = await app.inject({
        method: "PATCH",
        url: "/api/v1/students/me",
        headers: await getAuthHeaders(account),
        payload: { name: "Updated Name", areaId: area.id },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).name).toBe("Updated Name");
      expect(JSON.parse(res.body).areaId).toBe(area.id);
    });

    it("returns 404 when no profile exists", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "STUDENT" });
      const headers = await getAuthHeaders(account);

      const res = await app.inject({
        method: "PATCH",
        url: "/api/v1/students/me",
        headers,
        payload: { name: "Updated Name" },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe("contact number uniqueness across accounts", () => {
    it("rejects a phone number another account already uses", async () => {
      const app = await createTestApp();
      const area = await createArea();
      const tutor = await createAccount({ role: "TUTOR" });
      const taken = phone();
      await createTutorProfile(tutor.id, { phoneNumber: taken });
      const account = await createAccount({ role: "STUDENT" });
      const headers = await getAuthHeaders(account);

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/students/me",
        headers,
        payload: { ...studentPayload(area.id), phoneNumber: taken },
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).message).toBe("This phone number is already in use.");
    });

    it("rejects a phone that another account uses as its WhatsApp number", async () => {
      const app = await createTestApp();
      const area = await createArea();
      const tutor = await createAccount({ role: "TUTOR" });
      const taken = phone();
      await createTutorProfile(tutor.id, { whatsappNumber: taken });
      const account = await createAccount({ role: "STUDENT" });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/students/me",
        headers: await getAuthHeaders(account),
        payload: { ...studentPayload(area.id), phoneNumber: taken },
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).message).toBe("This phone number is already in use.");
    });

    it("rejects a WhatsApp number that another account uses as its phone", async () => {
      const app = await createTestApp();
      const area = await createArea();
      const tutor = await createAccount({ role: "TUTOR" });
      const taken = phone();
      await createTutorProfile(tutor.id, { phoneNumber: taken });
      const account = await createAccount({ role: "STUDENT" });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/students/me",
        headers: await getAuthHeaders(account),
        payload: { ...studentPayload(area.id), whatsappNumber: taken },
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).message).toBe("This WhatsApp number is already in use.");
    });

    it("GET /me returns a null WhatsApp number", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "STUDENT" });
      const area = await createArea();
      await createStudentProfile(account.id, area.id);

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/me",
        headers: await getAuthHeaders(account),
      });

      expect(JSON.parse(res.body).account.student.whatsappNumber).toBeNull();
    });
  });

  describe("createStudentProfile location atomicity", () => {
    it("leaves no student row when the location write fails", async () => {
      const account = await createAccount({ role: "STUDENT" });
      const area = await createArea();

      await expect(
        createStudentProfileService(account.id, {
          ...studentPayload(area.id),
          location: { lat: 200, lng: 90, addressText: "Out of range", districtCode: "dhaka" },
        }),
      ).rejects.toThrow();

      expect(await prisma.student.findUnique({ where: { accountId: account.id } })).toBeNull();
    });
  });

  describe("POST /api/v1/students/me/verification", () => {
    const url = "/api/v1/students/me/verification";

    async function setup() {
      const app = await createTestApp();
      const account = await createAccount({ role: "STUDENT" });
      const area = await createArea();
      const student = await createStudentProfile(account.id, area.id);
      return { app, account, student, headers: await getAuthHeaders(account) };
    }

    it("sends the ID for review", async () => {
      const { app, account, student, headers } = await setup();
      const file = await createFileAsset(account.id, "STUDENT_ID");

      const res = await app.inject({ method: "POST", url, headers, payload: { fileId: file.id } });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.verificationStatus).toBe("PENDING");
      expect(body.verificationNote).toBeNull();
      expect(body.verificationSubmittedAt).not.toBeNull();
      expect(body.verificationDecidedAt).toBeNull();
      const row = await prisma.student.findUniqueOrThrow({ where: { id: student.id } });
      expect(row.verificationStatus).toBe("PENDING");
      expect(row.verificationFileId).toBe(file.id);
      expect(row.verificationSubmittedAt).not.toBeNull();
    });

    it("returns 404 without a student profile", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "STUDENT" });
      const file = await createFileAsset(account.id, "STUDENT_ID");

      const res = await app.inject({
        method: "POST",
        url,
        headers: await getAuthHeaders(account),
        payload: { fileId: file.id },
      });

      expect(res.statusCode).toBe(404);
    });

    it("refuses a second submission while under review (409)", async () => {
      const { app, account, headers } = await setup();
      const first = await createFileAsset(account.id, "STUDENT_ID");
      const second = await createFileAsset(account.id, "STUDENT_ID");
      await app.inject({ method: "POST", url, headers, payload: { fileId: first.id } });

      const res = await app.inject({
        method: "POST",
        url,
        headers,
        payload: { fileId: second.id },
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).code).toBe("INVALID_VERIFICATION_STATE");
      expect(JSON.parse(res.body).message).toBe("Your ID is already under review.");
    });

    it("refuses a submission once verified (409)", async () => {
      const { app, account, student, headers } = await setup();
      const file = await createFileAsset(account.id, "STUDENT_ID");
      await prisma.student.update({
        where: { id: student.id },
        data: { verificationFileId: file.id, verificationStatus: "APPROVED" },
      });
      const next = await createFileAsset(account.id, "STUDENT_ID");

      const res = await app.inject({ method: "POST", url, headers, payload: { fileId: next.id } });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).message).toBe("Your ID is already verified.");
    });

    it("accepts a new ID after rejection and clears the review", async () => {
      const { app, account, student, headers } = await setup();
      const first = await createFileAsset(account.id, "STUDENT_ID");
      const second = await createFileAsset(account.id, "STUDENT_ID");
      await app.inject({ method: "POST", url, headers, payload: { fileId: first.id } });
      await prisma.student.update({
        where: { id: student.id },
        data: {
          verificationStatus: "REJECTED",
          verificationNote: "The photo is blurry",
          verificationDecidedAt: new Date(),
        },
      });

      const res = await app.inject({
        method: "POST",
        url,
        headers,
        payload: { fileId: second.id },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.verificationStatus).toBe("PENDING");
      expect(body.verificationNote).toBeNull();
      expect(body.verificationDecidedAt).toBeNull();
      const row = await prisma.student.findUniqueOrThrow({ where: { id: student.id } });
      expect(row.verificationFileId).toBe(second.id);
      expect(row.verificationNote).toBeNull();
      expect(row.verificationDecidedAt).toBeNull();
    });

    it("refuses a file that belongs to someone else (400 INVALID_FILE)", async () => {
      const { app, headers } = await setup();
      const other = await createAccount({ role: "STUDENT" });
      const file = await createFileAsset(other.id, "STUDENT_ID");

      const res = await app.inject({ method: "POST", url, headers, payload: { fileId: file.id } });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe("INVALID_FILE");
    });

    it("refuses a file uploaded for another purpose (400 INVALID_FILE)", async () => {
      const { app, account, headers } = await setup();
      const file = await createFileAsset(account.id, "TUTOR_ID");

      const res = await app.inject({ method: "POST", url, headers, payload: { fileId: file.id } });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe("INVALID_FILE");
    });

    it("refuses a file that is still uploading (400 INVALID_FILE)", async () => {
      const { app, account, headers } = await setup();
      const file = await createFileAsset(account.id, "STUDENT_ID", { status: "PENDING_UPLOAD" });

      const res = await app.inject({ method: "POST", url, headers, payload: { fileId: file.id } });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe("INVALID_FILE");
    });

    it("refuses a file that is already attached (409 FILE_IN_USE)", async () => {
      const { app, account, student, headers } = await setup();
      const file = await createFileAsset(account.id, "STUDENT_ID");
      await app.inject({ method: "POST", url, headers, payload: { fileId: file.id } });
      await prisma.student.update({
        where: { id: student.id },
        data: { verificationStatus: "REJECTED" },
      });

      const res = await app.inject({ method: "POST", url, headers, payload: { fileId: file.id } });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).code).toBe("FILE_IN_USE");
    });

    it("rejects a body without a fileId (400)", async () => {
      const { app, headers } = await setup();

      const res = await app.inject({ method: "POST", url, headers, payload: {} });

      expect(res.statusCode).toBe(400);
    });

    it("shows the review fields to the student on GET /me", async () => {
      const { app, account, student, headers } = await setup();
      const file = await createFileAsset(account.id, "STUDENT_ID");
      await prisma.student.update({
        where: { id: student.id },
        data: {
          verificationFileId: file.id,
          verificationStatus: "REJECTED",
          verificationNote: "Name does not match",
          verificationSubmittedAt: new Date("2026-01-02T03:04:05Z"),
          verificationDecidedAt: new Date("2026-01-03T03:04:05Z"),
        },
      });

      const res = await app.inject({ method: "GET", url: "/api/v1/me", headers });

      const me = JSON.parse(res.body).account.student;
      expect(me.verificationNote).toBe("Name does not match");
      expect(me.verificationSubmittedAt).toBe("2026-01-02T03:04:05.000Z");
      expect(me.verificationDecidedAt).toBe("2026-01-03T03:04:05.000Z");
    });

    it("hides a note the admin did not share from GET /me and the owner profile", async () => {
      const { app, account, student, headers } = await setup();
      const file = await createFileAsset(account.id, "STUDENT_ID");
      await prisma.student.update({
        where: { id: student.id },
        data: {
          verificationFileId: file.id,
          verificationStatus: "REJECTED",
          verificationNote: "Internal: possible duplicate account.",
          verificationNoteVisible: false,
          verificationSubmittedAt: new Date("2026-01-02T03:04:05Z"),
          verificationDecidedAt: new Date("2026-01-03T03:04:05Z"),
        },
      });

      const me = await app.inject({ method: "GET", url: "/api/v1/me", headers });
      expect(me.statusCode).toBe(200);
      const meStudent = JSON.parse(me.body).account.student;
      expect(meStudent.verificationStatus).toBe("REJECTED");
      expect(meStudent.verificationNote).toBeNull();
      expect(meStudent.verificationDecidedAt).toBe("2026-01-03T03:04:05.000Z");
      expect(me.body).not.toContain("Internal:");

      const owner = await app.inject({
        method: "PATCH",
        url: "/api/v1/students/me",
        headers,
        payload: { name: "Renamed Student" },
      });
      expect(owner.statusCode).toBe(200);
      expect(JSON.parse(owner.body).verificationNote).toBeNull();
      expect(owner.body).not.toContain("Internal:");
    });

    it("shows a note the admin shared on GET /me", async () => {
      const { app, account, student, headers } = await setup();
      const file = await createFileAsset(account.id, "STUDENT_ID");
      await prisma.student.update({
        where: { id: student.id },
        data: {
          verificationFileId: file.id,
          verificationStatus: "REJECTED",
          verificationNote: "Name does not match",
          verificationNoteVisible: true,
          verificationDecidedAt: new Date("2026-01-03T03:04:05Z"),
        },
      });

      const res = await app.inject({ method: "GET", url: "/api/v1/me", headers });

      expect(JSON.parse(res.body).account.student.verificationNote).toBe("Name does not match");
    });

    it("does not add the review fields to the public student profile", async () => {
      const { app, account, student } = await setup();
      const file = await createFileAsset(account.id, "STUDENT_ID");
      await prisma.student.update({
        where: { id: student.id },
        data: {
          verificationFileId: file.id,
          verificationStatus: "PENDING",
          verificationNote: "Private note",
        },
      });
      const tutorAccount = await createAccount({ role: "TUTOR" });
      const tutor = await createTutorProfile(tutorAccount.id);
      const subject = await createSubject();
      const requirement = await createRequirement({
        studentId: student.id,
        areaId: student.areaId,
        subjectId: subject.id,
      });
      await createApplication({
        requirementId: requirement.id,
        tutorId: tutor.id,
        studentId: student.id,
        initiatedBy: "TUTOR",
        status: "PENDING",
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/students/${student.id}`,
        headers: await getAuthHeaders(tutorAccount),
      });

      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain("Private note");
      expect(res.body).not.toContain("verificationStatus");
    });
  });

  describe("student verification file storage", () => {
    it("never returns the storage key in the owner's profile", async () => {
      const fake = createFakeStorage();
      setStorageForTests(fake.storage);
      const app = await createTestApp();
      const account = await createAccount({ role: "STUDENT" });
      const area = await createArea();
      await createStudentProfile(account.id, area.id);
      const file = await createFileAsset(account.id, "STUDENT_ID", {
        storageKey: "student_id/secret-key.pdf",
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/students/me/verification",
        headers: await getAuthHeaders(account),
        payload: { fileId: file.id },
      });

      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain("secret-key");
      expect(res.body).not.toContain("storageKey");
      setStorageForTests(null);
    });
  });

  describe("GET /api/v1/students/:id", () => {
    it("returns a limited profile for a tutor with a shared application", async () => {
      const app = await createTestApp();
      const studentAccount = await createAccount({ role: "STUDENT" });
      const tutorAccount = await createAccount({ role: "TUTOR" });
      const area = await createArea();
      const subject = await createSubject();
      const student = await createStudentProfile(studentAccount.id, area.id);
      const tutor = await createTutorProfile(tutorAccount.id);
      const requirement = await createRequirement({
        studentId: student.id,
        areaId: area.id,
        subjectId: subject.id,
      });
      await createApplication({
        requirementId: requirement.id,
        tutorId: tutor.id,
        studentId: student.id,
        initiatedBy: "TUTOR",
      });
      const headers = await getAuthHeaders(tutorAccount);

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/students/${student.id}`,
        headers,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.id).toBe(student.id);
      expect(body.name).toBe(student.name);
      expect(body.ratingAvg).toBe(0);
    });

    it("allows admins to view", async () => {
      const app = await createTestApp();
      const adminAccount = await createAccount({ role: "ADMIN" });
      const studentAccount = await createAccount({ role: "STUDENT" });
      const area = await createArea();
      const student = await createStudentProfile(studentAccount.id, area.id);
      const headers = await getAuthHeaders(adminAccount);

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/students/${student.id}`,
        headers,
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).id).toBe(student.id);
    });

    it("forbids tutors without a shared application", async () => {
      const app = await createTestApp();
      const studentAccount = await createAccount({ role: "STUDENT" });
      const tutorAccount = await createAccount({ role: "TUTOR" });
      const area = await createArea();
      const student = await createStudentProfile(studentAccount.id, area.id);
      await createTutorProfile(tutorAccount.id);
      const headers = await getAuthHeaders(tutorAccount);

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/students/${student.id}`,
        headers,
      });

      expect(res.statusCode).toBe(403);
    });

    it("forbids students", async () => {
      const app = await createTestApp();
      const studentAccount = await createAccount({ role: "STUDENT" });
      const otherStudent = await createAccount({ role: "STUDENT" });
      const area = await createArea();
      const student = await createStudentProfile(studentAccount.id, area.id);
      await createStudentProfile(otherStudent.id, area.id);
      const headers = await getAuthHeaders(otherStudent);

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/students/${student.id}`,
        headers,
      });

      expect(res.statusCode).toBe(403);
    });

    it("requires authentication", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "STUDENT" });
      const area = await createArea();
      const student = await createStudentProfile(account.id, area.id);

      const res = await app.inject({ method: "GET", url: `/api/v1/students/${student.id}` });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("GET /api/v1/students/:id/reviews", () => {
    it("returns reviews given to the student", async () => {
      const app = await createTestApp();
      const studentAccount = await createAccount({ role: "STUDENT" });
      const tutorAccount = await createAccount({ role: "TUTOR" });
      const area = await createArea();
      const subject = await createSubject();
      const student = await createStudentProfile(studentAccount.id, area.id);
      const tutor = await createTutorProfile(tutorAccount.id);
      const requirement = await createRequirement({
        studentId: student.id,
        areaId: area.id,
        subjectId: subject.id,
      });
      await createApplication({
        requirementId: requirement.id,
        tutorId: tutor.id,
        studentId: student.id,
        initiatedBy: "TUTOR",
        status: "CONFIRMED",
      });
      await prisma.review.create({
        data: {
          tutorId: tutor.id,
          studentId: student.id,
          direction: "TUTOR_TO_STUDENT",
          rating: 5,
          comment: "Great student",
        },
      });
      const headers = await getAuthHeaders(studentAccount);

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/students/${student.id}/reviews`,
        headers,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.reviews).toHaveLength(1);
      expect(body.reviews[0].rating).toBe(5);
    });

    it("requires authentication", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "STUDENT" });
      const area = await createArea();
      const student = await createStudentProfile(account.id, area.id);

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/students/${student.id}/reviews`,
      });
      expect(res.statusCode).toBe(401);
    });
  });
});
