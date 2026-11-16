import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { mapContactNumberError } from "../../lib/contact-numbers.js";
import { prisma } from "../../lib/prisma.js";
import {
  createAccount,
  createApplication,
  createArea,
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
  setStudentLocation,
  setTutorLocation,
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
      expect(JSON.parse(res.body).error).toBe("ProfileExists");
      expect(JSON.parse(res.body).code).toBe("PROFILE_EXISTS");
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

    it("saves the institute name trimmed and returns it", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/tutors/me",
        headers: await getAuthHeaders(account),
        payload: tutorPayload({ instituteName: "  University of Dhaka  " }),
      });

      expect(res.statusCode).toBe(201);
      expect(JSON.parse(res.body).instituteName).toBe("University of Dhaka");
      const row = await prisma.tutor.findUnique({ where: { accountId: account.id } });
      expect(row?.instituteName).toBe("University of Dhaka");
    });

    it("accepts a 120-character institute name", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/tutors/me",
        headers: await getAuthHeaders(account),
        payload: tutorPayload({ instituteName: "x".repeat(120) }),
      });

      expect(res.statusCode).toBe(201);
      expect(JSON.parse(res.body).instituteName).toHaveLength(120);
    });

    it("keeps the profile valid without an institute name (older web builds)", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/tutors/me",
        headers: await getAuthHeaders(account),
        payload: tutorPayload(),
      });

      expect(res.statusCode).toBe(201);
      expect(JSON.parse(res.body).instituteName).toBeNull();
    });

    it("rejects an institute name over 120 characters (400)", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/tutors/me",
        headers: await getAuthHeaders(account),
        payload: tutorPayload({ instituteName: "x".repeat(121) }),
      });

      expect(res.statusCode).toBe(400);
    });

    it("rejects an empty or blank institute name (400)", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      const headers = await getAuthHeaders(account);

      for (const instituteName of ["", "   "]) {
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/tutors/me",
          headers,
          payload: tutorPayload({ instituteName }),
        });
        expect(res.statusCode).toBe(400);
      }
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

    it("updates the institute name trimmed", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      await createTutorProfile(account.id, { instituteName: "Old College" });

      const res = await app.inject({
        method: "PATCH",
        url: "/api/v1/tutors/me",
        headers: await getAuthHeaders(account),
        payload: { instituteName: "  BUET  " },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).instituteName).toBe("BUET");
    });

    it("rejects a blank or over-long institute name (400)", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      await createTutorProfile(account.id);
      const headers = await getAuthHeaders(account);

      const blank = await app.inject({
        method: "PATCH",
        url: "/api/v1/tutors/me",
        headers,
        payload: { instituteName: " " },
      });
      const tooLong = await app.inject({
        method: "PATCH",
        url: "/api/v1/tutors/me",
        headers,
        payload: { instituteName: "x".repeat(121) },
      });

      expect(blank.statusCode).toBe(400);
      expect(tooLong.statusCode).toBe(400);
    });
  });

  describe("GET /api/v1/me", () => {
    it("returns instituteName on the tutor profile", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      await createTutorProfile(account.id, { instituteName: "University of Dhaka" });

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/me",
        headers: await getAuthHeaders(account),
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).account.tutor.instituteName).toBe("University of Dhaka");
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
      expect(JSON.parse(res.body).code).toBe("NOT_FOUND");
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

    it("rejects an area outside the tutor's city (409)", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      const tutor = await createTutorProfile(account.id);
      await setTutorLocation(tutor.id);
      const dhaka = await createArea();
      const ctg = await createArea({ district: "Chattogram", division: "Chattogram" });

      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/tutors/me/areas",
        headers: await getAuthHeaders(account),
        payload: { areaIds: [dhaka.id, ctg.id] },
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body)).toEqual({
        error: "AreaOutsideCity",
        code: "AREA_OUTSIDE_CITY",
        message: "All areas must be within your city",
        details: { invalidAreaIds: [ctg.id] },
      });
      expect(await prisma.tutorArea.count({ where: { tutorId: tutor.id } })).toBe(0);
    });

    it("accepts areas in the tutor's city", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      const tutor = await createTutorProfile(account.id);
      await setTutorLocation(tutor.id);
      const dhaka = await createArea();

      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/tutors/me/areas",
        headers: await getAuthHeaders(account),
        payload: { areaIds: [dhaka.id] },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).areas).toHaveLength(1);
    });

    it("skips the city check when the tutor has no saved location", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      await createTutorProfile(account.id);
      const ctg = await createArea({ district: "Chattogram", division: "Chattogram" });

      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/tutors/me/areas",
        headers: await getAuthHeaders(account),
        payload: { areaIds: [ctg.id] },
      });

      expect(res.statusCode).toBe(200);
    });

    it("rejects an unknown area id (409)", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      await createTutorProfile(account.id);

      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/tutors/me/areas",
        headers: await getAuthHeaders(account),
        payload: { areaIds: [2147483000] },
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).code).toBe("AREA_OUTSIDE_CITY");
      expect(JSON.parse(res.body).details.invalidAreaIds).toEqual([2147483000]);
    });

    it("rejects a non-positive area id with a ValidationError (400)", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      await createTutorProfile(account.id);

      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/tutors/me/areas",
        headers: await getAuthHeaders(account),
        payload: { areaIds: [-1] },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe("ValidationError");
      expect(body.code).toBe("VALIDATION_ERROR");
      expect(body.issues[0].path).toEqual(["areaIds", 0]);
      expect(typeof body.issues[0].message).toBe("string");
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
          levelMin: 6,
          levelMax: 10,
          curricula: ["BANGLA_MEDIUM"],
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
      expect(body.code).toBe("REQUIREMENT_LOSES_LAST_SUBJECT");
      expect(body.details.requirementIds).toEqual([requirement.id]);
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
      expect(JSON.parse(res.body).code).toBe("NOT_IMPLEMENTED");
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

  describe("GET /api/v1/tutors/nearby", () => {
    it("returns instituteName, areas and subjects for each nearby tutor", async () => {
      const app = await createTestApp();
      const area = await createArea();
      const studentAccount = await createAccount({ role: "STUDENT" });
      const student = await createStudentProfile(studentAccount.id, area.id);
      await setStudentLocation(student.id, { districtCode: "dhaka", lat: 23.73, lng: 90.4 });

      const tutorAccount = await createAccount({ role: "TUTOR" });
      const tutor = await createTutorProfile(tutorAccount.id, {
        isListed: true,
        instituteName: "University of Dhaka",
      });
      await setTutorLocation(tutor.id, { districtCode: "dhaka", lat: 23.735, lng: 90.405 });
      const areaA = await createArea({ name: "Dhanmondi" });
      const areaB = await createArea({ name: "Mohammadpur" });
      const subject = await createSubject({ name: "Physics" });
      await prisma.tutorArea.createMany({
        data: [
          { tutorId: tutor.id, areaId: areaA.id },
          { tutorId: tutor.id, areaId: areaB.id },
        ],
      });
      await prisma.tutorSubject.create({ data: { tutorId: tutor.id, subjectId: subject.id } });

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/tutors/nearby?radiusMeters=2000",
        headers: await getAuthHeaders(studentAccount),
      });

      expect(res.statusCode).toBe(200);
      const [card] = JSON.parse(res.body).tutors;
      expect(card.id).toBe(tutor.id);
      expect(card.instituteName).toBe("University of Dhaka");
      expect(card.areas).toHaveLength(2);
      expect(card.areas).toEqual(
        expect.arrayContaining([
          { id: areaA.id, name: "Dhanmondi" },
          { id: areaB.id, name: "Mohammadpur" },
        ]),
      );
      expect(card.subjects).toEqual([{ id: subject.id, name: "Physics" }]);
      expect(card.distanceMeters).toBeLessThan(2000);
    });

    it("keeps distance order and gives each tutor only its own areas and subjects", async () => {
      const app = await createTestApp();
      const area = await createArea();
      const studentAccount = await createAccount({ role: "STUDENT" });
      const student = await createStudentProfile(studentAccount.id, area.id);
      await setStudentLocation(student.id, { districtCode: "dhaka", lat: 23.73, lng: 90.4 });

      const closeAccount = await createAccount({ role: "TUTOR" });
      const closeTutor = await createTutorProfile(closeAccount.id, { isListed: true });
      await setTutorLocation(closeTutor.id, { districtCode: "dhaka", lat: 23.735, lng: 90.405 });
      const farAccount = await createAccount({ role: "TUTOR" });
      const farTutor = await createTutorProfile(farAccount.id, {
        isListed: true,
        instituteName: "Far College",
      });
      await setTutorLocation(farTutor.id, { districtCode: "dhaka", lat: 23.74, lng: 90.41 });

      const closeArea = await createArea({ name: "Close Area" });
      const farArea = await createArea({ name: "Far Area" });
      await prisma.tutorArea.create({ data: { tutorId: closeTutor.id, areaId: closeArea.id } });
      await prisma.tutorArea.create({ data: { tutorId: farTutor.id, areaId: farArea.id } });

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/tutors/nearby?radiusMeters=5000",
        headers: await getAuthHeaders(studentAccount),
      });

      expect(res.statusCode).toBe(200);
      const tutors = JSON.parse(res.body).tutors;
      expect(tutors.map((t: { id: string }) => t.id)).toEqual([closeTutor.id, farTutor.id]);
      expect(tutors[0].instituteName).toBeNull();
      expect(tutors[0].areas).toEqual([{ id: closeArea.id, name: "Close Area" }]);
      expect(tutors[0].subjects).toEqual([]);
      expect(tutors[1].instituteName).toBe("Far College");
      expect(tutors[1].areas).toEqual([{ id: farArea.id, name: "Far Area" }]);
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

    it("returns instituteName in search results", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      await createTutorProfile(account.id, { isListed: true, instituteName: "BUET" });

      const res = await app.inject({ method: "GET", url: "/api/v1/tutors" });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).tutors[0].instituteName).toBe("BUET");
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

    it("returns instituteName on the public profile", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      const tutor = await createTutorProfile(account.id, {
        isListed: true,
        instituteName: "University of Dhaka",
      });

      const res = await app.inject({ method: "GET", url: `/api/v1/tutors/${tutor.id}` });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).tutor.instituteName).toBe("University of Dhaka");
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
      const subject = await createSubject();
      const tutor = await createTutorProfile(tutorAccount.id);
      const student = await createStudentProfile(studentAccount.id, area.id);
      const requirement = await createRequirement({
        studentId: student.id,
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
      expect(JSON.parse(res.body).code).toBe("NOT_IMPLEMENTED");
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
      expect(JSON.parse(res.body).code).toBe("NOT_IMPLEMENTED");
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
      expect(JSON.parse(res.body).error).toBe("PhoneInUse");
      expect(JSON.parse(res.body).code).toBe("PHONE_IN_USE");
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
      expect(JSON.parse(res.body).error).toBe("WhatsappInUse");
      expect(JSON.parse(res.body).code).toBe("WHATSAPP_IN_USE");
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
      expect(JSON.parse(res.body).error).toBe("PhoneInUse");
      expect(JSON.parse(res.body).code).toBe("PHONE_IN_USE");
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
      expect(JSON.parse(res.body).error).toBe("PhoneInUse");
      expect(JSON.parse(res.body).code).toBe("PHONE_IN_USE");
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
      const ratings = [5, 3, 4, 2];

      const students = [];
      for (const _ of ratings) {
        const account = await createAccount({ role: "STUDENT" });
        const student = await createStudentProfile(account.id, area.id);
        const requirement = await createRequirement({
          studentId: student.id,
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
        levelMin: 6,
        levelMax: 10,
        curricula: ["BANGLA_MEDIUM", "ENGLISH_VERSION"],
        academicGroups: [],
        admissionTargets: [],
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
      expect(JSON.parse(res.body).error).toBe("RequirementLimitReached");
      expect(JSON.parse(res.body).code).toBe("REQUIREMENT_LIMIT_REACHED");
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
      expect(JSON.parse(res.body).error).toBe("InvalidSubjectOrZone");
      expect(JSON.parse(res.body).code).toBe("INVALID_SUBJECT_OR_ZONE");
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
      expect(JSON.parse(res.body).error).toBe("InvalidSubjectOrZone");
      expect(JSON.parse(res.body).code).toBe("INVALID_SUBJECT_OR_ZONE");
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

    it("lists only archived sets, newest-changed first, for status=archived", async () => {
      const app = await createTestApp();
      const { tutor, headers } = await setupTutor();
      await createTutorRequirement(tutor.id, { name: "Active Set" });
      const older = await createTutorRequirement(tutor.id, {
        name: "Older Archived",
        isActive: false,
      });
      const newer = await createTutorRequirement(tutor.id, {
        name: "Newer Archived",
        isActive: false,
      });
      await prisma.tutorRequirement.update({
        where: { id: older.id },
        data: { updatedAt: new Date("2024-01-01T00:00:00Z") },
      });
      await prisma.tutorRequirement.update({
        where: { id: newer.id },
        data: { updatedAt: new Date("2024-02-01T00:00:00Z") },
      });

      const res = await app.inject({ method: "GET", url: `${base}?status=archived`, headers });

      expect(res.statusCode).toBe(200);
      const requirements = JSON.parse(res.body).requirements;
      expect(requirements.map((r: { name: string }) => r.name)).toEqual([
        "Newer Archived",
        "Older Archived",
      ]);
      expect(requirements.every((r: { isActive: boolean }) => r.isActive === false)).toBe(true);
    });

    it("lists active sets before archived ones for status=all", async () => {
      const app = await createTestApp();
      const { tutor, headers } = await setupTutor();
      await createTutorRequirement(tutor.id, { name: "Archived Set", isActive: false });
      await createTutorRequirement(tutor.id, { name: "Active Set", isDefault: true });

      const res = await app.inject({ method: "GET", url: `${base}?status=all`, headers });

      expect(res.statusCode).toBe(200);
      const names = JSON.parse(res.body).requirements.map((r: { name: string }) => r.name);
      expect(names).toEqual(["Active Set", "Archived Set"]);
    });

    it("rejects an unknown status (400)", async () => {
      const app = await createTestApp();
      const { headers } = await setupTutor();

      const res = await app.inject({ method: "GET", url: `${base}?status=deleted`, headers });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe("ValidationError");
      expect(JSON.parse(res.body).code).toBe("VALIDATION_ERROR");
    });

    it("moves a restored set from the archived list to the active list", async () => {
      const app = await createTestApp();
      const { tutor, headers, subjects } = await setupTutor();
      await createTutorRequirement(tutor.id, { isDefault: true });
      const archived = await createTutorRequirement(tutor.id, {
        name: "Restored Set",
        isActive: false,
        subjectIds: [subjects[0].id],
      });

      await app.inject({ method: "POST", url: `${base}/${archived.id}/restore`, headers });
      const active = await app.inject({ method: "GET", url: base, headers });
      const archivedList = await app.inject({
        method: "GET",
        url: `${base}?status=archived`,
        headers,
      });

      expect(JSON.parse(active.body).requirements.map((r: { id: string }) => r.id)).toContain(
        archived.id,
      );
      expect(JSON.parse(archivedList.body).requirements).toEqual([]);
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
        payload: { levelMin: 12 },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe("InvalidRequirement");
      expect(JSON.parse(res.body).code).toBe("INVALID_REQUIREMENT");
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
      expect(JSON.parse(res.body).error).toBe("ValidationError");
      expect(JSON.parse(res.body).code).toBe("VALIDATION_ERROR");
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
      expect(JSON.parse(res.body).error).toBe("RequirementArchived");
      expect(JSON.parse(res.body).code).toBe("REQUIREMENT_ARCHIVED");
    });

    it("refuses to archive the default set (409)", async () => {
      const app = await createTestApp();
      const { tutor, headers } = await setupTutor();
      const set = await createTutorRequirement(tutor.id, { isDefault: true });

      const res = await app.inject({ method: "DELETE", url: `${base}/${set.id}`, headers });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).error).toBe("RequirementIsDefault");
      expect(JSON.parse(res.body).code).toBe("REQUIREMENT_IS_DEFAULT");
    });

    it("refuses to archive a set used by an OPEN package (409) and lists it", async () => {
      const app = await createTestApp();
      const { tutor, headers } = await setupTutor();
      await createTutorRequirement(tutor.id, { isDefault: true });
      const set = await createTutorRequirement(tutor.id);
      const pkg = await createTuitionPackage(tutor.id, { requirementId: set.id });

      const res = await app.inject({ method: "DELETE", url: `${base}/${set.id}`, headers });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).error).toBe("RequirementInUse");
      expect(JSON.parse(res.body).code).toBe("REQUIREMENT_IN_USE");
      expect(JSON.parse(res.body).details.packageIds).toContain(pkg.id);
      expect(JSON.parse(res.body).code).toBe("REQUIREMENT_IN_USE");
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
      expect(JSON.parse(res.body).error).toBe("RequirementLimitReached");
      expect(JSON.parse(res.body).code).toBe("REQUIREMENT_LIMIT_REACHED");
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

    it("accepts level 13 and rejects 14 (400)", async () => {
      const app = await createTestApp();
      const { headers, subjects } = await setupTutor();
      const subjectIds = [subjects[0].id];

      const accepted = await app.inject({
        method: "POST",
        url: base,
        headers,
        payload: requirementPayload({ levelMin: 13, levelMax: 13, subjectIds }),
      });
      const rejected = await app.inject({
        method: "POST",
        url: base,
        headers,
        payload: requirementPayload({ levelMax: 14, subjectIds }),
      });

      expect(accepted.statusCode).toBe(201);
      expect(rejected.statusCode).toBe(400);
      expect(JSON.parse(rejected.body).error).toBe("ValidationError");
      expect(JSON.parse(rejected.body).code).toBe("VALIDATION_ERROR");
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
      expect(JSON.parse(res.body).error).toBe("RequirementHasNoSubjects");
      expect(JSON.parse(res.body).code).toBe("REQUIREMENT_NO_SUBJECTS");
      const detail = await app.inject({ method: "GET", url: `${base}/${second.id}`, headers });
      expect(JSON.parse(detail.body).isActive).toBe(false);
    });

    describe("education coverage fields", () => {
      async function postSet(app: Awaited<ReturnType<typeof createTestApp>>, payload: object) {
        const { headers, subjects } = await setupTutor();
        return app.inject({
          method: "POST",
          url: base,
          headers,
          payload: requirementPayload({ subjectIds: [subjects[0].id], ...payload }),
        });
      }

      it("accepts the full level range with curriculum, group and target and echoes them", async () => {
        const app = await createTestApp();
        const { headers, subjects } = await setupTutor();

        const res = await app.inject({
          method: "POST",
          url: base,
          headers,
          payload: requirementPayload({
            levelMin: -4,
            levelMax: 13,
            curricula: ["MADRASAH"],
            academicGroups: ["MUJABBID"],
            admissionTargets: ["ISSB"],
            subjectIds: [subjects[0].id],
          }),
        });

        expect(res.statusCode).toBe(201);
        expect(JSON.parse(res.body)).toMatchObject({
          levelMin: -4,
          levelMax: 13,
          curricula: ["MADRASAH"],
          academicGroups: ["MUJABBID"],
          admissionTargets: ["ISSB"],
        });
      });

      it("rejects an empty curricula list (400)", async () => {
        const app = await createTestApp();

        const res = await postSet(app, { curricula: [] });

        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.body).code).toBe("VALIDATION_ERROR");
      });

      it("rejects a group when the range does not cover levels 9 to 12 (400)", async () => {
        const app = await createTestApp();

        const res = await postSet(app, {
          levelMin: 1,
          levelMax: 8,
          academicGroups: ["SCIENCE"],
        });

        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.body).code).toBe("VALIDATION_ERROR");
        expect(JSON.parse(res.body).issues).toContainEqual(
          expect.objectContaining({ path: ["academicGroups"] }),
        );
      });

      it("rejects a group that no chosen curriculum offers (400)", async () => {
        const app = await createTestApp();

        const res = await postSet(app, {
          levelMin: 9,
          levelMax: 12,
          curricula: ["MADRASAH"],
          academicGroups: ["BUSINESS"],
        });

        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.body).code).toBe("VALIDATION_ERROR");
      });

      it("rejects admission targets when the range does not reach level 13 (400)", async () => {
        const app = await createTestApp();

        const res = await postSet(app, {
          levelMin: 9,
          levelMax: 12,
          admissionTargets: ["MEDICAL"],
        });

        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.body).code).toBe("VALIDATION_ERROR");
      });

      it("rejects a range whose minimum is above its maximum (400)", async () => {
        const app = await createTestApp();

        const res = await postSet(app, { levelMin: 5, levelMax: 4 });

        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.body).code).toBe("VALIDATION_ERROR");
      });

      it("rejects a PATCH that leaves a group outside the merged range (400)", async () => {
        const app = await createTestApp();
        const { tutor, headers } = await setupTutor();
        const set = await createTutorRequirement(tutor.id, {
          isDefault: true,
          levelMin: 9,
          levelMax: 12,
          curricula: ["BANGLA_MEDIUM"],
          academicGroups: ["SCIENCE"],
        });

        const res = await app.inject({
          method: "PATCH",
          url: `${base}/${set.id}`,
          headers,
          payload: { levelMax: 8 },
        });

        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.body).error).toBe("InvalidRequirement");
        expect(JSON.parse(res.body).code).toBe("INVALID_REQUIREMENT");
      });

      it("accepts a PATCH that switches curricula on a plain set (200)", async () => {
        const app = await createTestApp();
        const { tutor, headers } = await setupTutor();
        const set = await createTutorRequirement(tutor.id, { isDefault: true });

        const res = await app.inject({
          method: "PATCH",
          url: `${base}/${set.id}`,
          headers,
          payload: { curricula: ["EM_IB"] },
        });

        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body).curricula).toEqual(["EM_IB"]);
      });
    });

    describe("syncProfileSubjects", () => {
      it("adds a new subject to the profile when creating a set with the flag (201)", async () => {
        const app = await createTestApp();
        const { tutor, headers } = await setupTutor();
        const extra = await createSubject();

        const res = await app.inject({
          method: "POST",
          url: base,
          headers,
          payload: requirementPayload({ subjectIds: [extra.id], syncProfileSubjects: true }),
        });

        expect(res.statusCode).toBe(201);
        expect(JSON.parse(res.body).subjectIds).toEqual([extra.id]);
        const profile = await prisma.tutorSubject.findMany({ where: { tutorId: tutor.id } });
        expect(profile.map((row) => row.subjectId)).toContain(extra.id);
      });

      it("rejects a subject missing from the profile without the flag (400)", async () => {
        const app = await createTestApp();
        const { tutor, headers } = await setupTutor();
        const extra = await createSubject();
        const before = await prisma.tutorSubject.count({ where: { tutorId: tutor.id } });

        const res = await app.inject({
          method: "POST",
          url: base,
          headers,
          payload: requirementPayload({ subjectIds: [extra.id] }),
        });

        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.body).code).toBe("INVALID_SUBJECT_OR_ZONE");
        expect(await prisma.tutorSubject.count({ where: { tutorId: tutor.id } })).toBe(before);
      });

      it.each([false, true])(
        "treats an unknown subject as a validation error (syncProfileSubjects=%s)",
        async (sync) => {
          const app = await createTestApp();
          const { headers } = await setupTutor();

          const res = await app.inject({
            method: "POST",
            url: base,
            headers,
            payload: requirementPayload({ subjectIds: [999999], syncProfileSubjects: sync }),
          });

          expect(res.statusCode).toBe(400);
          expect(JSON.parse(res.body).code).toBe("VALIDATION_ERROR");
          expect(JSON.parse(res.body).message).toBe("Unknown subject");
        },
      );

      it("treats an inactive subject as unknown (400)", async () => {
        const app = await createTestApp();
        const { tutor, headers } = await setupTutor();
        const inactive = await createSubject();
        await prisma.subject.update({ where: { id: inactive.id }, data: { isActive: false } });

        const res = await app.inject({
          method: "POST",
          url: base,
          headers,
          payload: requirementPayload({ subjectIds: [inactive.id], syncProfileSubjects: true }),
        });

        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.body).message).toBe("Unknown subject");
        expect(
          await prisma.tutorSubject.findFirst({
            where: { tutorId: tutor.id, subjectId: inactive.id },
          }),
        ).toBeNull();
      });

      it("rolls the profile back when the set write fails (400)", async () => {
        const app = await createTestApp();
        const { tutor, headers } = await setupTutor();
        const extra = await createSubject();

        const res = await app.inject({
          method: "POST",
          url: base,
          headers,
          payload: requirementPayload({
            subjectIds: [extra.id],
            zoneIds: [crypto.randomUUID()],
            syncProfileSubjects: true,
          }),
        });

        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.body).code).toBe("INVALID_SUBJECT_OR_ZONE");
        expect(
          await prisma.tutorSubject.findFirst({
            where: { tutorId: tutor.id, subjectId: extra.id },
          }),
        ).toBeNull();
      });

      it("adds a new subject to the profile when editing a set with the flag (200)", async () => {
        const app = await createTestApp();
        const { tutor, headers, subjects } = await setupTutor();
        const set = await createTutorRequirement(tutor.id, { subjectIds: [subjects[0].id] });
        const extra = await createSubject();

        const res = await app.inject({
          method: "PATCH",
          url: `${base}/${set.id}`,
          headers,
          payload: { subjectIds: [subjects[0].id, extra.id], syncProfileSubjects: true },
        });

        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body).subjectIds).toEqual(
          [subjects[0].id, extra.id].sort((a, b) => a - b),
        );
        const profile = await prisma.tutorSubject.findMany({ where: { tutorId: tutor.id } });
        expect(profile.map((row) => row.subjectId)).toContain(extra.id);
      });

      it("rejects a PATCH that only sets the flag (400)", async () => {
        const app = await createTestApp();
        const { tutor, headers } = await setupTutor();
        const set = await createTutorRequirement(tutor.id);

        const res = await app.inject({
          method: "PATCH",
          url: `${base}/${set.id}`,
          headers,
          payload: { syncProfileSubjects: true },
        });

        expect(res.statusCode).toBe(400);
      });

      it("refuses to grow the profile past 50 subjects (400)", async () => {
        const app = await createTestApp();
        const { tutor, headers } = await setupTutor(50);
        const extra = await createSubject();

        const res = await app.inject({
          method: "POST",
          url: base,
          headers,
          payload: requirementPayload({ subjectIds: [extra.id], syncProfileSubjects: true }),
        });

        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.body).error).toBe("ValidationError");
        expect(JSON.parse(res.body).code).toBe("VALIDATION_ERROR");
        expect(JSON.parse(res.body).message).toBe("A tutor can have at most 50 subjects");
        expect(await prisma.tutorSubject.count({ where: { tutorId: tutor.id } })).toBe(50);
      });

      it("does not echo the flag in the response", async () => {
        const app = await createTestApp();
        const { headers } = await setupTutor();
        const extra = await createSubject();

        const res = await app.inject({
          method: "POST",
          url: base,
          headers,
          payload: requirementPayload({ subjectIds: [extra.id], syncProfileSubjects: true }),
        });

        expect(res.statusCode).toBe(201);
        expect(JSON.parse(res.body)).not.toHaveProperty("syncProfileSubjects");
      });

      it("lets PUT /me/subjects drop the only subject of an archived set (200)", async () => {
        const app = await createTestApp();
        const { tutor, headers, subjects } = await setupTutor(2);
        const [s1, s2] = subjects;
        const archived = await createTutorRequirement(tutor.id, {
          isActive: false,
          subjectIds: [s1.id],
        });

        const res = await app.inject({
          method: "PUT",
          url: "/api/v1/tutors/me/subjects",
          headers,
          payload: { subjectIds: [s2.id] },
        });

        expect(res.statusCode).toBe(200);
        expect(
          await prisma.tutorRequirementSubject.findMany({
            where: { requirementId: archived.id },
          }),
        ).toHaveLength(0);
      });
    });
  });
});
