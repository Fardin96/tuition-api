import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { prisma } from "../../lib/prisma.js";
import {
  createAccount,
  createApplication,
  createArea,
  createCategory,
  createFileAsset,
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

function tutorPayload(overrides: Record<string, unknown> = {}) {
  return {
    name: "Tutor Name",
    address: "Tutor Address",
    emergencyContact: "+8801700000002",
    whatsappNumber: phone(),
    studentIdNumber: `TUT-${crypto.randomUUID()}`,
    gender: "MALE",
    ...overrides,
  };
}

describe("tutor routes", () => {
  describe("POST /api/v1/tutors/me", () => {
    it("creates a tutor profile", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      const headers = await getAuthHeaders(account);

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/tutors/me",
        headers,
        payload: tutorPayload(),
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.name).toBe("Tutor Name");
      expect(body.isListed).toBe(false);
    });

    it("rejects non-tutor accounts", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "STUDENT" });
      const headers = await getAuthHeaders(account);

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/tutors/me",
        headers,
        payload: tutorPayload(),
      });

      expect(res.statusCode).toBe(403);
    });

    it("rejects duplicate profiles", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      const headers = await getAuthHeaders(account);
      const payload = tutorPayload();

      await app.inject({ method: "POST", url: "/api/v1/tutors/me", headers, payload });
      const res = await app.inject({ method: "POST", url: "/api/v1/tutors/me", headers, payload });

      expect(res.statusCode).toBe(409);
    });
  });

  describe("PATCH /api/v1/tutors/me", () => {
    it("updates the profile", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      await createTutorProfile(account.id);
      const headers = await getAuthHeaders(account);

      const res = await app.inject({
        method: "PATCH",
        url: "/api/v1/tutors/me",
        headers,
        payload: { name: "Updated Tutor" },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).name).toBe("Updated Tutor");
    });

    it("returns 404 when no profile exists", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      const headers = await getAuthHeaders(account);

      const res = await app.inject({
        method: "PATCH",
        url: "/api/v1/tutors/me",
        headers,
        payload: { name: "Updated Tutor" },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe("PUT /api/v1/tutors/me/areas", () => {
    it("replaces the tutor's areas", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      await createTutorProfile(account.id);
      const area = await createArea();
      const headers = await getAuthHeaders(account);

      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/tutors/me/areas",
        headers,
        payload: { areaIds: [area.id] },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).areas).toHaveLength(1);
    });

    it("returns 404 without a profile", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      const area = await createArea();
      const headers = await getAuthHeaders(account);

      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/tutors/me/areas",
        headers,
        payload: { areaIds: [area.id] },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe("PUT /api/v1/tutors/me/subjects", () => {
    it("replaces the tutor's subjects", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      await createTutorProfile(account.id);
      const subject = await createSubject();
      const headers = await getAuthHeaders(account);

      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/tutors/me/subjects",
        headers,
        payload: { subjectIds: [subject.id] },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).subjects).toHaveLength(1);
    });
  });

  describe("POST /api/v1/tutors/me/verifications", () => {
    it("is deferred", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      const headers = await getAuthHeaders(account);

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/tutors/me/verifications",
        headers,
      });

      expect(res.statusCode).toBe(501);
      expect(JSON.parse(res.body).error).toBe("NotImplemented");
    });
  });

  describe("GET /api/v1/tutors/me/verifications", () => {
    it("returns the submission history", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      const tutor = await createTutorProfile(account.id);
      const file = await createFileAsset(account.id, "TUTOR_ID");
      await prisma.tutorVerification.create({
        data: { tutorId: tutor.id, fileId: file.id },
      });
      const headers = await getAuthHeaders(account);

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/tutors/me/verifications",
        headers,
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).verifications).toHaveLength(1);
    });
  });

  describe("GET /api/v1/tutors", () => {
    it("lists only listed tutors", async () => {
      const app = await createTestApp();
      const listedAccount = await createAccount({ role: "TUTOR" });
      const unlistedAccount = await createAccount({ role: "TUTOR" });
      await createTutorProfile(listedAccount.id, { isListed: true, name: "Listed Tutor" });
      await createTutorProfile(unlistedAccount.id, { isListed: false, name: "Unlisted Tutor" });

      const res = await app.inject({ method: "GET", url: "/api/v1/tutors" });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.tutors).toHaveLength(1);
      expect(body.tutors[0].name).toBe("Listed Tutor");
    });

    it("filters by area", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      const area = await createArea();
      const tutor = await createTutorProfile(account.id, { isListed: true });
      await prisma.tutorArea.create({ data: { tutorId: tutor.id, areaId: area.id } });

      const res = await app.inject({ method: "GET", url: `/api/v1/tutors?area=${area.id}` });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).tutors).toHaveLength(1);
    });

    it("filters by subject", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      const subject = await createSubject();
      const tutor = await createTutorProfile(account.id, { isListed: true });
      await prisma.tutorSubject.create({ data: { tutorId: tutor.id, subjectId: subject.id } });

      const res = await app.inject({ method: "GET", url: `/api/v1/tutors?subject=${subject.id}` });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).tutors).toHaveLength(1);
    });

    it("filters by name", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      await createTutorProfile(account.id, { isListed: true, name: "Filterable Name" });

      const res = await app.inject({ method: "GET", url: "/api/v1/tutors?name=Filterable" });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).tutors).toHaveLength(1);
    });
  });

  describe("GET /api/v1/tutors/:id", () => {
    it("returns the public profile", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      const area = await createArea();
      const subject = await createSubject();
      const tutor = await createTutorProfile(account.id, { isListed: true });
      await prisma.tutorArea.create({ data: { tutorId: tutor.id, areaId: area.id } });
      await prisma.tutorSubject.create({ data: { tutorId: tutor.id, subjectId: subject.id } });
      const file = await createFileAsset(account.id, "CREDENTIAL");
      await prisma.tutorCredential.create({
        data: { tutorId: tutor.id, examLabel: "SSC", result: "A+", fileId: file.id },
      });
      const videoFile = await createFileAsset(account.id, "TUTOR_VIDEO");
      await prisma.tutorVideo.create({
        data: { tutorId: tutor.id, fileId: videoFile.id, title: "Intro", status: "APPROVED" },
      });

      const res = await app.inject({ method: "GET", url: `/api/v1/tutors/${tutor.id}` });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.tutor.areas).toHaveLength(1);
      expect(body.tutor.subjects).toHaveLength(1);
      expect(body.tutor.credentials).toHaveLength(1);
      expect(body.tutor.videos).toHaveLength(1);
    });

    it("returns 404 for unknown tutor", async () => {
      const app = await createTestApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/tutors/00000000-0000-0000-0000-000000000000",
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("GET /api/v1/tutors/:id/reviews", () => {
    it("returns visible reviews", async () => {
      const app = await createTestApp();
      const tutorAccount = await createAccount({ role: "TUTOR" });
      const studentAccount = await createAccount({ role: "STUDENT" });
      const area = await createArea();
      const category = await createCategory();
      const subject = await createSubject();
      const tutor = await createTutorProfile(tutorAccount.id);
      const student = await createStudentProfile(studentAccount.id, area.id);
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
        initiatedBy: "STUDENT",
        status: "CONFIRMED",
      });
      await prisma.review.create({
        data: {
          tutorId: tutor.id,
          studentId: student.id,
          direction: "STUDENT_TO_TUTOR",
          rating: 4,
          comment: "Good tutor",
        },
      });

      const res = await app.inject({ method: "GET", url: `/api/v1/tutors/${tutor.id}/reviews` });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.reviews).toHaveLength(1);
      expect(body.reviews[0].rating).toBe(4);
    });
  });

  describe("GET /api/v1/tutors/me/credentials", () => {
    it("returns the tutor's credentials", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      const tutor = await createTutorProfile(account.id);
      const file = await createFileAsset(account.id, "CREDENTIAL");
      await prisma.tutorCredential.create({
        data: { tutorId: tutor.id, examLabel: "HSC", result: "A", fileId: file.id },
      });
      const headers = await getAuthHeaders(account);

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/tutors/me/credentials",
        headers,
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).credentials).toHaveLength(1);
    });
  });

  describe("POST /api/v1/tutors/me/credentials", () => {
    it("is deferred", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      const headers = await getAuthHeaders(account);

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/tutors/me/credentials",
        headers,
      });

      expect(res.statusCode).toBe(501);
      expect(JSON.parse(res.body).error).toBe("NotImplemented");
    });
  });

  describe("DELETE /api/v1/tutors/me/credentials/:id", () => {
    it("deletes the credential", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      const tutor = await createTutorProfile(account.id);
      const file = await createFileAsset(account.id, "CREDENTIAL");
      const credential = await prisma.tutorCredential.create({
        data: { tutorId: tutor.id, examLabel: "SSC", result: "5.00", fileId: file.id },
      });
      const headers = await getAuthHeaders(account);

      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/tutors/me/credentials/${credential.id}`,
        headers,
      });

      expect(res.statusCode).toBe(204);
      const remaining = await prisma.tutorCredential.count({ where: { tutorId: tutor.id } });
      expect(remaining).toBe(0);
    });

    it("returns 404 for unknown credentials", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      await createTutorProfile(account.id);
      const headers = await getAuthHeaders(account);

      const res = await app.inject({
        method: "DELETE",
        url: "/api/v1/tutors/me/credentials/00000000-0000-0000-0000-000000000000",
        headers,
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe("GET /api/v1/tutors/me/videos", () => {
    it("returns the tutor's videos", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      const tutor = await createTutorProfile(account.id);
      const file = await createFileAsset(account.id, "TUTOR_VIDEO");
      await prisma.tutorVideo.create({
        data: { tutorId: tutor.id, fileId: file.id, title: "Demo" },
      });
      const headers = await getAuthHeaders(account);

      const res = await app.inject({ method: "GET", url: "/api/v1/tutors/me/videos", headers });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).videos).toHaveLength(1);
    });
  });

  describe("POST /api/v1/tutors/me/videos", () => {
    it("is deferred", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      const headers = await getAuthHeaders(account);

      const res = await app.inject({ method: "POST", url: "/api/v1/tutors/me/videos", headers });

      expect(res.statusCode).toBe(501);
      expect(JSON.parse(res.body).error).toBe("NotImplemented");
    });
  });

  describe("DELETE /api/v1/tutors/me/videos/:id", () => {
    it("deletes the video", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      const tutor = await createTutorProfile(account.id);
      const file = await createFileAsset(account.id, "TUTOR_VIDEO");
      const video = await prisma.tutorVideo.create({
        data: { tutorId: tutor.id, fileId: file.id, title: "Delete me" },
      });
      const headers = await getAuthHeaders(account);

      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/tutors/me/videos/${video.id}`,
        headers,
      });

      expect(res.statusCode).toBe(204);
      const remaining = await prisma.tutorVideo.count({ where: { tutorId: tutor.id } });
      expect(remaining).toBe(0);
    });
  });

  describe("GET /api/v1/videos", () => {
    it("returns approved videos", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      const tutor = await createTutorProfile(account.id);
      const approvedFile = await createFileAsset(account.id, "TUTOR_VIDEO");
      const pendingFile = await createFileAsset(account.id, "TUTOR_VIDEO");
      await prisma.tutorVideo.create({
        data: { tutorId: tutor.id, fileId: approvedFile.id, title: "Approved", status: "APPROVED" },
      });
      await prisma.tutorVideo.create({
        data: { tutorId: tutor.id, fileId: pendingFile.id, title: "Pending", status: "PENDING" },
      });

      const res = await app.inject({ method: "GET", url: "/api/v1/videos" });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.videos).toHaveLength(1);
      expect(body.videos[0].title).toBe("Approved");
    });
  });
});
