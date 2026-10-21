import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { prisma } from "../../lib/prisma.js";
import {
  createAccount,
  createApplication,
  createArea,
  createCategory,
  createRequirement,
  createStudentProfile,
  createSubject,
  createTestApp,
  createTutorProfile,
  getAuthHeaders,
} from "../../tests/helpers.js";

function phone() {
  return `+88017${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
}

function studentPayload(areaId: number) {
  return {
    name: "Student Name",
    areaId,
    address: "Student Address",
    emergencyContact: "+8801700000001",
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

  describe("POST /api/v1/students/me/verification", () => {
    it("is deferred", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "STUDENT" });
      const headers = await getAuthHeaders(account);

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/students/me/verification",
        headers,
      });

      expect(res.statusCode).toBe(501);
      expect(JSON.parse(res.body).error).toBe("NotImplemented");
    });
  });

  describe("GET /api/v1/students/:id", () => {
    it("returns a limited profile for a tutor with a shared application", async () => {
      const app = await createTestApp();
      const studentAccount = await createAccount({ role: "STUDENT" });
      const tutorAccount = await createAccount({ role: "TUTOR" });
      const area = await createArea();
      const category = await createCategory();
      const subject = await createSubject();
      const student = await createStudentProfile(studentAccount.id, area.id);
      const tutor = await createTutorProfile(tutorAccount.id);
      const requirement = await createRequirement({
        studentId: student.id,
        categoryId: category.id,
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
      const category = await createCategory();
      const subject = await createSubject();
      const student = await createStudentProfile(studentAccount.id, area.id);
      const tutor = await createTutorProfile(tutorAccount.id);
      const requirement = await createRequirement({
        studentId: student.id,
        categoryId: category.id,
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
