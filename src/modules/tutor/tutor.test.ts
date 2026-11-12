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
  createTuitionPackage,
  createTutorProfile,
  createTutorRequirement,
  createTutorZone,
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
    phoneNumber: phone(),
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

    it("creates a tutor profile without a WhatsApp number", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      const { whatsappNumber: _whatsapp, ...payload } = tutorPayload();

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/tutors/me",
        headers: await getAuthHeaders(account),
        payload,
      });

      expect(res.statusCode).toBe(201);
      expect(JSON.parse(res.body).whatsappNumber).toBeNull();
    });

    it("rejects a tutor profile without a phone number", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      const { phoneNumber: _phone, ...payload } = tutorPayload();

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/tutors/me",
        headers: await getAuthHeaders(account),
        payload,
      });

      expect(res.statusCode).toBe(400);
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

    it("clears the WhatsApp number and its verification when set to null", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      await createTutorProfile(account.id, { whatsappNumber: phone() });
      await prisma.tutor.update({
        where: { accountId: account.id },
        data: { whatsappVerifiedAt: new Date() },
      });

      const res = await app.inject({
        method: "PATCH",
        url: "/api/v1/tutors/me",
        headers: await getAuthHeaders(account),
        payload: { whatsappNumber: null },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).whatsappNumber).toBeNull();
      expect(JSON.parse(res.body).whatsappVerifiedAt).toBeNull();
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

    it("only touches the diff: kept rows are not rewritten", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      const tutor = await createTutorProfile(account.id);
      const kept = await createArea();
      const dropped = await createArea();
      const added = await createArea();
      await prisma.tutorArea.createMany({
        data: [
          { tutorId: tutor.id, areaId: kept.id },
          { tutorId: tutor.id, areaId: dropped.id },
        ],
      });
      const keptXmin = () =>
        prisma.$queryRaw<{ xmin: string }[]>`
          SELECT xmin::text AS xmin FROM tutor_area
          WHERE tutor_id = ${tutor.id}::uuid AND area_id = ${kept.id}`;
      const [before] = await keptXmin();

      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/tutors/me/areas",
        headers: await getAuthHeaders(account),
        payload: { areaIds: [kept.id, added.id, added.id] },
      });

      expect(res.statusCode).toBe(200);
      const ids = JSON.parse(res.body).areas.map((a: { area: { id: number } }) => a.area.id);
      expect(ids.sort()).toEqual([kept.id, added.id].sort());
      const [after] = await keptXmin();
      expect(after.xmin).toBe(before.xmin);
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

    async function createActiveRequirement(tutorId: string, subjectIds: number[]) {
      const requirement = await prisma.tutorRequirement.create({
        data: {
          tutorId,
          name: "Evening Math",
          classLevelMin: 6,
          classLevelMax: 10,
          timeFrom: new Date("1970-01-01T10:00:00Z"),
          timeTo: new Date("1970-01-01T12:00:00Z"),
          availableFrom: new Date("2024-01-01"),
          teachesOnline: true,
        },
      });
      await prisma.tutorRequirementSubject.createMany({
        data: subjectIds.map((subjectId) => ({
          requirementId: requirement.id,
          tutorId,
          subjectId,
        })),
      });
      return requirement;
    }

    it("keeps requirement subjects of subjects that stay", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      const tutor = await createTutorProfile(account.id);
      const [s1, s2, s3] = [await createSubject(), await createSubject(), await createSubject()];
      await prisma.tutorSubject.createMany({
        data: [s1, s2].map((s) => ({ tutorId: tutor.id, subjectId: s.id })),
      });
      const requirement = await createActiveRequirement(tutor.id, [s1.id, s2.id]);

      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/tutors/me/subjects",
        headers: await getAuthHeaders(account),
        payload: { subjectIds: [s1.id, s3.id] },
      });

      expect(res.statusCode).toBe(200);
      const rows = await prisma.tutorRequirementSubject.findMany({
        where: { requirementId: requirement.id },
      });
      expect(rows.map((r) => r.subjectId)).toEqual([s1.id]);
    });

    it("refuses to remove the last subject of an active requirement (409)", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      const tutor = await createTutorProfile(account.id);
      const s1 = await createSubject();
      const s2 = await createSubject();
      await prisma.tutorSubject.create({ data: { tutorId: tutor.id, subjectId: s1.id } });
      const requirement = await createActiveRequirement(tutor.id, [s1.id]);

      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/tutors/me/subjects",
        headers: await getAuthHeaders(account),
        payload: { subjectIds: [s2.id] },
      });

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.error).toBe("RequirementLosesLastSubject");
      expect(body.requirementIds).toEqual([requirement.id]);
      expect(await prisma.tutorSubject.findMany({ where: { tutorId: tutor.id } })).toHaveLength(1);
      expect(
        await prisma.tutorRequirementSubject.findMany({ where: { requirementId: requirement.id } }),
      ).toHaveLength(1);
    });

    it("allows removing a subject from a requirement that keeps others", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      const tutor = await createTutorProfile(account.id);
      const s1 = await createSubject();
      const s2 = await createSubject();
      await prisma.tutorSubject.createMany({
        data: [s1, s2].map((s) => ({ tutorId: tutor.id, subjectId: s.id })),
      });
      const requirement = await createActiveRequirement(tutor.id, [s1.id, s2.id]);

      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/tutors/me/subjects",
        headers: await getAuthHeaders(account),
        payload: { subjectIds: [s1.id] },
      });

      expect(res.statusCode).toBe(200);
      expect(
        await prisma.tutorRequirementSubject.findMany({ where: { requirementId: requirement.id } }),
      ).toHaveLength(1);
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

    it("rejects a phone that equals another account's WhatsApp number (PhoneInUse)", async () => {
      const app = await createTestApp();
      const other = await createAccount({ role: "STUDENT" });
      const area = await createArea();
      const taken = phone();
      await createStudentProfile(other.id, area.id, { whatsappNumber: taken });
      const account = await createAccount({ role: "TUTOR" });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/tutors/me",
        headers: await getAuthHeaders(account),
        payload: tutorPayload({ phoneNumber: taken }),
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).message).toBe("This phone number is already in use.");
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

  describe("tutor requirements (/me/requirements)", () => {
    const base = "/api/v1/tutors/me/requirements";

    function requirementPayload(overrides: Record<string, unknown> = {}) {
      return {
        name: "Evening Math",
        classLevelMin: 6,
        classLevelMax: 10,
        timeFrom: "10:00",
        timeTo: "12:00",
        availableDays: 127,
        minSalary: 5000,
        maxStudents: 2,
        availableFrom: "2024-01-01",
        teachesOnline: true,
        subjectIds: [],
        zoneIds: [],
        ...overrides,
      };
    }

    async function setupTutor(subjectCount = 1, zoneCount = 0) {
      const account = await createAccount({ role: "TUTOR" });
      const tutor = await createTutorProfile(account.id);
      const subjects = [];
      for (let i = 0; i < subjectCount; i++) subjects.push(await createSubject());
      await prisma.tutorSubject.createMany({
        data: subjects.map((s) => ({ tutorId: tutor.id, subjectId: s.id })),
      });
      const zoneIds: string[] = [];
      for (let i = 0; i < zoneCount; i++) zoneIds.push(await createTutorZone(tutor.id));
      return { account, tutor, subjects, zoneIds, headers: await getAuthHeaders(account) };
    }

    it("makes the first set the default", async () => {
      const app = await createTestApp();
      const { headers, subjects } = await setupTutor();

      const res = await app.inject({
        method: "POST",
        url: base,
        headers,
        payload: requirementPayload({ subjectIds: [subjects[0].id] }),
      });

      expect(res.statusCode).toBe(201);
      expect(JSON.parse(res.body).isDefault).toBe(true);
    });

    it("creates later sets as non-default", async () => {
      const app = await createTestApp();
      const { headers, subjects } = await setupTutor();
      const payload = requirementPayload({ subjectIds: [subjects[0].id] });
      await app.inject({ method: "POST", url: base, headers, payload });

      const res = await app.inject({ method: "POST", url: base, headers, payload });

      expect(res.statusCode).toBe(201);
      expect(JSON.parse(res.body).isDefault).toBe(false);
    });

    it("rejects an 11th active set (409)", async () => {
      const app = await createTestApp();
      const { tutor, headers, subjects } = await setupTutor();
      for (let i = 0; i < 10; i++) await createTutorRequirement(tutor.id);

      const res = await app.inject({
        method: "POST",
        url: base,
        headers,
        payload: requirementPayload({ subjectIds: [subjects[0].id] }),
      });

      expect(res.statusCode).toBe(409);
    });

    it("rejects a subject that is not on the tutor's profile (400)", async () => {
      const app = await createTestApp();
      const { headers } = await setupTutor();
      const other = await createSubject();

      const res = await app.inject({
        method: "POST",
        url: base,
        headers,
        payload: requirementPayload({ subjectIds: [other.id] }),
      });

      expect(res.statusCode).toBe(400);
    });

    it("rejects another tutor's zone (400)", async () => {
      const app = await createTestApp();
      const { headers, subjects } = await setupTutor();
      const otherAccount = await createAccount({ role: "TUTOR" });
      const otherTutor = await createTutorProfile(otherAccount.id);
      const otherZone = await createTutorZone(otherTutor.id);

      const res = await app.inject({
        method: "POST",
        url: base,
        headers,
        payload: requirementPayload({ subjectIds: [subjects[0].id], zoneIds: [otherZone] }),
      });

      expect(res.statusCode).toBe(400);
    });

    it("returns 404 for another tutor's set", async () => {
      const app = await createTestApp();
      const { headers } = await setupTutor();
      const otherAccount = await createAccount({ role: "TUTOR" });
      const otherTutor = await createTutorProfile(otherAccount.id);
      const otherSet = await createTutorRequirement(otherTutor.id);

      const res = await app.inject({ method: "GET", url: `${base}/${otherSet.id}`, headers });

      expect(res.statusCode).toBe(404);
    });

    it("forbids students (403)", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "STUDENT" });

      const res = await app.inject({
        method: "GET",
        url: base,
        headers: await getAuthHeaders(account),
      });

      expect(res.statusCode).toBe(403);
    });

    it("hides archived sets from the list", async () => {
      const app = await createTestApp();
      const { tutor, headers } = await setupTutor();
      await createTutorRequirement(tutor.id, { name: "Active Set" });
      await createTutorRequirement(tutor.id, { name: "Archived Set", isActive: false });

      const res = await app.inject({ method: "GET", url: base, headers });

      expect(res.statusCode).toBe(200);
      const names = JSON.parse(res.body).requirements.map((r: { name: string }) => r.name);
      expect(names).toEqual(["Active Set"]);
    });

    it("returns an archived set on detail GET with isActive false", async () => {
      const app = await createTestApp();
      const { tutor, headers } = await setupTutor();
      const archived = await createTutorRequirement(tutor.id, { isActive: false });

      const res = await app.inject({ method: "GET", url: `${base}/${archived.id}`, headers });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).isActive).toBe(false);
    });

    it("allows editing an archived set (200)", async () => {
      const app = await createTestApp();
      const { tutor, headers } = await setupTutor();
      const archived = await createTutorRequirement(tutor.id, { isActive: false });

      const res = await app.inject({
        method: "PATCH",
        url: `${base}/${archived.id}`,
        headers,
        payload: { name: "Renamed" },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).name).toBe("Renamed");
    });

    it("rejects a merged class range that is invalid (400)", async () => {
      const app = await createTestApp();
      const { tutor, headers } = await setupTutor();
      const set = await createTutorRequirement(tutor.id, { isDefault: true });

      const res = await app.inject({
        method: "PATCH",
        url: `${base}/${set.id}`,
        headers,
        payload: { classLevelMin: 15 },
      });

      expect(res.statusCode).toBe(400);
    });

    it("rejects an empty subjectIds list on PATCH (400)", async () => {
      const app = await createTestApp();
      const { tutor, headers } = await setupTutor();
      const set = await createTutorRequirement(tutor.id, { isDefault: true });

      const res = await app.inject({
        method: "PATCH",
        url: `${base}/${set.id}`,
        headers,
        payload: { subjectIds: [] },
      });

      expect(res.statusCode).toBe(400);
    });

    it("applies subject and zone diffs on PATCH", async () => {
      const app = await createTestApp();
      const { tutor, headers, subjects, zoneIds } = await setupTutor(3, 3);
      const [s1, s2, s3] = subjects;
      const [z1, z2, z3] = zoneIds;
      const set = await createTutorRequirement(tutor.id, {
        isDefault: true,
        subjectIds: [s1.id, s2.id],
        zoneIds: [z1, z2],
      });

      const res = await app.inject({
        method: "PATCH",
        url: `${base}/${set.id}`,
        headers,
        payload: { subjectIds: [s1.id, s3.id], zoneIds: [z2, z3] },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect([...body.subjectIds].sort()).toEqual([s1.id, s3.id].sort());
      expect([...body.zoneIds].sort()).toEqual([z2, z3].sort());
      const subjectRows = await prisma.tutorRequirementSubject.findMany({
        where: { requirementId: set.id },
      });
      const zoneRows = await prisma.tutorRequirementZone.findMany({
        where: { requirementId: set.id },
      });
      expect(subjectRows.map((r) => r.subjectId).sort()).toEqual([s1.id, s3.id].sort());
      expect(zoneRows.map((r) => r.zoneId).sort()).toEqual([z2, z3].sort());
    });

    it("moves the default when set-default is called", async () => {
      const app = await createTestApp();
      const { tutor, headers } = await setupTutor();
      const first = await createTutorRequirement(tutor.id, { isDefault: true });
      const second = await createTutorRequirement(tutor.id);

      const res = await app.inject({
        method: "POST",
        url: `${base}/${second.id}/default`,
        headers,
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).isDefault).toBe(true);
      const oldDefault = await prisma.tutorRequirement.findUniqueOrThrow({
        where: { id: first.id },
      });
      expect(oldDefault.isDefault).toBe(false);
    });

    it("refuses set-default on an archived set (409)", async () => {
      const app = await createTestApp();
      const { tutor, headers } = await setupTutor();
      await createTutorRequirement(tutor.id, { isDefault: true });
      const archived = await createTutorRequirement(tutor.id, { isActive: false });

      const res = await app.inject({
        method: "POST",
        url: `${base}/${archived.id}/default`,
        headers,
      });

      expect(res.statusCode).toBe(409);
    });

    it("refuses to archive the default set (409)", async () => {
      const app = await createTestApp();
      const { tutor, headers } = await setupTutor();
      const set = await createTutorRequirement(tutor.id, { isDefault: true });

      const res = await app.inject({ method: "DELETE", url: `${base}/${set.id}`, headers });

      expect(res.statusCode).toBe(409);
    });

    it("refuses to archive a set used by an OPEN package (409) and lists it", async () => {
      const app = await createTestApp();
      const { tutor, headers } = await setupTutor();
      await createTutorRequirement(tutor.id, { isDefault: true });
      const set = await createTutorRequirement(tutor.id);
      const pkg = await createTuitionPackage(tutor.id, { requirementId: set.id });

      const res = await app.inject({ method: "DELETE", url: `${base}/${set.id}`, headers });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).packageIds).toContain(pkg.id);
      const row = await prisma.tutorRequirement.findUniqueOrThrow({ where: { id: set.id } });
      expect(row.isActive).toBe(true);
    });

    it("archives an unused non-default set (200)", async () => {
      const app = await createTestApp();
      const { tutor, headers } = await setupTutor();
      await createTutorRequirement(tutor.id, { isDefault: true });
      const set = await createTutorRequirement(tutor.id);

      const res = await app.inject({ method: "DELETE", url: `${base}/${set.id}`, headers });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).isActive).toBe(false);
    });

    it("restores an archived set (200)", async () => {
      const app = await createTestApp();
      const { tutor, headers, subjects } = await setupTutor();
      await createTutorRequirement(tutor.id, { isDefault: true });
      const archived = await createTutorRequirement(tutor.id, {
        isActive: false,
        subjectIds: [subjects[0].id],
      });

      const res = await app.inject({
        method: "POST",
        url: `${base}/${archived.id}/restore`,
        headers,
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).isActive).toBe(true);
    });

    it("refuses to restore when 10 sets are already active (409)", async () => {
      const app = await createTestApp();
      const { tutor, headers, subjects } = await setupTutor();
      for (let i = 0; i < 10; i++) {
        await createTutorRequirement(tutor.id, { isDefault: i === 0 });
      }
      const archived = await createTutorRequirement(tutor.id, {
        isActive: false,
        subjectIds: [subjects[0].id],
      });

      const res = await app.inject({
        method: "POST",
        url: `${base}/${archived.id}/restore`,
        headers,
      });

      expect(res.statusCode).toBe(409);
    });

    it("restoring an active set returns 200", async () => {
      const app = await createTestApp();
      const { tutor, headers } = await setupTutor();
      const set = await createTutorRequirement(tutor.id, { isDefault: true });

      const res = await app.inject({
        method: "POST",
        url: `${base}/${set.id}/restore`,
        headers,
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).isActive).toBe(true);
    });

    it("counts OPEN packages, including null-requirement ones on the default set", async () => {
      const app = await createTestApp();
      const { tutor, headers } = await setupTutor();
      const defaultSet = await createTutorRequirement(tutor.id, { isDefault: true });
      const other = await createTutorRequirement(tutor.id);
      await createTuitionPackage(tutor.id, { requirementId: defaultSet.id });
      await createTuitionPackage(tutor.id, { requirementId: null });
      await createTuitionPackage(tutor.id, { requirementId: other.id });
      await createTuitionPackage(tutor.id, { requirementId: defaultSet.id, status: "CLOSED" });

      const res = await app.inject({ method: "GET", url: base, headers });

      const sets: { id: string; mappedPackageCount: number }[] = JSON.parse(res.body).requirements;
      expect(sets.find((s) => s.id === defaultSet.id)?.mappedPackageCount).toBe(2);
      expect(sets.find((s) => s.id === other.id)?.mappedPackageCount).toBe(1);
    });

    it("accepts class level 20 and rejects 21 (400)", async () => {
      const app = await createTestApp();
      const { headers, subjects } = await setupTutor();
      const subjectIds = [subjects[0].id];

      const accepted = await app.inject({
        method: "POST",
        url: base,
        headers,
        payload: requirementPayload({ classLevelMin: 20, classLevelMax: 20, subjectIds }),
      });
      const rejected = await app.inject({
        method: "POST",
        url: base,
        headers,
        payload: requirementPayload({ classLevelMax: 21, subjectIds }),
      });

      expect(accepted.statusCode).toBe(201);
      expect(rejected.statusCode).toBe(400);
    });

    it("PATCH with one field leaves the other fields and zones unchanged", async () => {
      const app = await createTestApp();
      const { headers, subjects, zoneIds } = await setupTutor(1, 1);
      const created = await app.inject({
        method: "POST",
        url: base,
        headers,
        payload: requirementPayload({
          availableDays: 31,
          maxStudents: 3,
          teachesOnline: false,
          minSalary: 7000,
          subjectIds: [subjects[0].id],
          zoneIds,
        }),
      });
      const id = JSON.parse(created.body).id;

      const res = await app.inject({
        method: "PATCH",
        url: `${base}/${id}`,
        headers,
        payload: { name: "Renamed" },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.name).toBe("Renamed");
      expect(body.availableDays).toBe(31);
      expect(body.maxStudents).toBe(3);
      expect(body.teachesOnline).toBe(false);
      expect(body.minSalary).toBe(7000);
      expect(body.zoneIds).toContain(zoneIds[0]);
    });

    it("restore rejects an archived set that has no subjects (409)", async () => {
      const app = await createTestApp();
      const { tutor, headers, subjects } = await setupTutor();
      await createTutorRequirement(tutor.id, { isDefault: true, subjectIds: [subjects[0].id] });
      const second = await createTutorRequirement(tutor.id, { subjectIds: [subjects[0].id] });
      await app.inject({ method: "DELETE", url: `${base}/${second.id}`, headers });
      await prisma.tutorRequirementSubject.deleteMany({ where: { requirementId: second.id } });

      const res = await app.inject({
        method: "POST",
        url: `${base}/${second.id}/restore`,
        headers,
      });

      expect(res.statusCode).toBe(409);
      const detail = await app.inject({ method: "GET", url: `${base}/${second.id}`, headers });
      expect(JSON.parse(detail.body).isActive).toBe(false);
    });
  });
});
