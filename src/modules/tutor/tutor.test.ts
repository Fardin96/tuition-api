import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { mapContactNumberError } from "../../lib/contact-numbers.js";
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

    it("rejects a WhatsApp number starting with the reserved deleted: prefix", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      const headers = await getAuthHeaders(account);

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/tutors/me",
        headers,
        payload: tutorPayload({ whatsappNumber: "deleted:abc" }),
      });

      expect(res.statusCode).toBe(400);
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

  describe("contact number uniqueness across accounts", () => {
    it("rejects a phone number another account already uses (PhoneInUse)", async () => {
      const app = await createTestApp();
      const area = await createArea();
      const other = await createAccount({ role: "STUDENT" });
      const taken = phone();
      await createStudentProfile(other.id, area.id, { phoneNumber: taken });
      const account = await createAccount({ role: "TUTOR" });
      const headers = await getAuthHeaders(account);

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/tutors/me",
        headers,
        payload: tutorPayload({ phoneNumber: taken }),
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).message).toBe("This phone number is already in use.");
    });

    it("rejects a WhatsApp number that equals another account's phone (WhatsappInUse)", async () => {
      const app = await createTestApp();
      const other = await createAccount({ role: "TUTOR" });
      const taken = phone();
      await createTutorProfile(other.id, { phoneNumber: taken });
      const account = await createAccount({ role: "TUTOR" });
      const headers = await getAuthHeaders(account);

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/tutors/me",
        headers,
        payload: tutorPayload({ whatsappNumber: taken }),
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).message).toBe("This WhatsApp number is already in use.");
    });

    it("lets the same account use one number for phone and WhatsApp", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      const headers = await getAuthHeaders(account);
      const same = phone();

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/tutors/me",
        headers,
        payload: tutorPayload({ whatsappNumber: same, phoneNumber: same }),
      });

      expect(res.statusCode).toBe(201);
      expect(JSON.parse(res.body).phoneNumber).toBe(same);
    });

    it("does not save a PATCH to a number taken by another account", async () => {
      const app = await createTestApp();
      const other = await createAccount({ role: "TUTOR" });
      const taken = phone();
      await createTutorProfile(other.id, { phoneNumber: taken });
      const account = await createAccount({ role: "TUTOR" });
      await createTutorProfile(account.id);
      const headers = await getAuthHeaders(account);

      const res = await app.inject({
        method: "PATCH",
        url: "/api/v1/tutors/me",
        headers,
        payload: { phoneNumber: taken },
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).message).toBe("This phone number is already in use.");
      const saved = await prisma.tutor.findUnique({ where: { accountId: account.id } });
      expect(saved?.phoneNumber).not.toBe(taken);
    });

    it("rejects a raw SQL insert of a number held by another account (trigger)", async () => {
      const area = await createArea();
      const owner = await createAccount({ role: "TUTOR" });
      const taken = phone();
      await createTutorProfile(owner.id, { phoneNumber: taken });
      const student = await createAccount({ role: "STUDENT" });

      await expect(
        prisma.$executeRaw`
          INSERT INTO student (id, account_id, name, area_id, address, emergency_contact,
            whatsapp_number, phone_number, student_id_number, updated_at)
          VALUES (gen_random_uuid(), ${student.id}::uuid, 'Raw', ${area.id}, 'addr', '+8801700000001',
            ${taken}, ${taken}, ${`STU-${crypto.randomUUID()}`}, now())`,
      ).rejects.toThrow(/contact_number_in_use/);
    });

    it("maps a trigger rejection that slips past the pre-check to PhoneInUse", async () => {
      const area = await createArea();
      const owner = await createAccount({ role: "TUTOR" });
      const taken = phone();
      await createTutorProfile(owner.id, { phoneNumber: taken });
      const student = await createAccount({ role: "STUDENT" });
      const profile = await createStudentProfile(student.id, area.id);

      const err = await prisma.student
        .update({ where: { id: profile.id }, data: { phoneNumber: taken } })
        .catch((e: unknown) => e);

      await expect(
        mapContactNumberError(err, student.id, { phoneNumber: taken }),
      ).rejects.toMatchObject({ name: "PhoneInUse", statusCode: 409 });
    });
  });

  describe("public DTO allowlist", () => {
    it("leaves contact details and private fields out of the list and profile", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      const tutor = await createTutorProfile(account.id, {
        isListed: true,
        whatsappNumber: "+8801755555555",
        phoneNumber: "+8801766666666",
        address: "Secret Lane 9",
        emergencyContact: "+8801777777777",
        studentIdNumber: "PRIV-ID-1",
      });
      await prisma.tutor.update({
        where: { id: tutor.id },
        data: { parentsInfo: "Parent Secret" },
      });

      const list = await app.inject({ method: "GET", url: "/api/v1/tutors" });
      const profile = await app.inject({ method: "GET", url: `/api/v1/tutors/${tutor.id}` });

      expect(JSON.parse(list.body).tutors).toHaveLength(1);
      expect(JSON.parse(profile.body).tutor.name).toBe("Test Tutor");
      for (const body of [list.body, profile.body]) {
        for (const secret of [
          "+8801755555555",
          "+8801766666666",
          "+8801777777777",
          "Secret Lane 9",
          "PRIV-ID-1",
          "Parent Secret",
          account.id,
        ]) {
          expect(body).not.toContain(secret);
        }
        for (const key of [
          "phoneNumber",
          "whatsappNumber",
          "parentsInfo",
          "emergencyContact",
          "studentIdNumber",
          "address",
          "accountId",
        ]) {
          expect(body).not.toContain(`"${key}"`);
        }
      }
    });
  });

  describe("public cache headers", () => {
    const publicCache = "public, max-age=60, stale-while-revalidate=300";

    it("caches anonymous reads and revalidates with ETag", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      await createTutorProfile(account.id, { isListed: true });

      const res = await app.inject({ method: "GET", url: "/api/v1/tutors" });
      expect(res.headers["cache-control"]).toBe(publicCache);
      expect(res.headers.vary).toBe("Authorization");

      const revalidated = await app.inject({
        method: "GET",
        url: "/api/v1/tutors",
        headers: { "if-none-match": res.headers.etag as string },
      });
      expect(revalidated.statusCode).toBe(304);
    });

    it("marks signed-in reads as private and not stored", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      const tutor = await createTutorProfile(account.id, { isListed: true });
      const headers = await getAuthHeaders(account);

      for (const url of [
        "/api/v1/tutors",
        `/api/v1/tutors/${tutor.id}`,
        `/api/v1/tutors/${tutor.id}/reviews`,
        "/api/v1/videos",
      ]) {
        const res = await app.inject({ method: "GET", url, headers });
        expect(res.headers["cache-control"]).toBe("private, no-store");
      }
    });

    it("uses the longer window for reviews and videos", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      const tutor = await createTutorProfile(account.id, { isListed: true });

      for (const url of [`/api/v1/tutors/${tutor.id}/reviews`, "/api/v1/videos"]) {
        const res = await app.inject({ method: "GET", url });
        expect(res.headers["cache-control"]).toBe(
          "public, max-age=300, stale-while-revalidate=600",
        );
      }
    });
  });

  describe("review rating race", () => {
    it("keeps rating_count and rating_avg correct for concurrent reviews of one tutor", async () => {
      const tutorAccount = await createAccount({ role: "TUTOR" });
      const tutor = await createTutorProfile(tutorAccount.id, { isListed: true });
      const area = await createArea();
      const category = await createCategory();
      const ratings = [5, 3, 4, 2];

      const students = [];
      for (const _ of ratings) {
        const account = await createAccount({ role: "STUDENT" });
        const student = await createStudentProfile(account.id, area.id);
        const requirement = await createRequirement({
          studentId: student.id,
          categoryId: category.id,
        });
        await createApplication({
          requirementId: requirement.id,
          tutorId: tutor.id,
          studentId: student.id,
          initiatedBy: "STUDENT",
          status: "CONFIRMED",
        });
        students.push(student);
      }

      await Promise.all(
        students.map((student, i) =>
          prisma.review.create({
            data: {
              tutorId: tutor.id,
              studentId: student.id,
              direction: "STUDENT_TO_TUTOR",
              rating: ratings[i],
            },
          }),
        ),
      );

      const row = await prisma.tutor.findUniqueOrThrow({ where: { id: tutor.id } });
      expect(row.ratingCount).toBe(4);
      expect(Number(row.ratingAvg)).toBe(3.5);
    });
  });
});
