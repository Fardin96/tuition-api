import crypto from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { mapContactNumberError } from "../../lib/contact-numbers.js";
import { prisma } from "../../lib/prisma.js";
import { setStorageForTests } from "../../lib/storage.js";
import {
  createAccount,
  createAdmin,
  createApplication,
  createArea,
  createFakeStorage,
  createFileAsset,
  createLandingRow,
  createRequirement,
  createStudentProfile,
  createSubject,
  createTestApp,
  createTuitionPackage,
  createTutorProfile,
  createTutorRequirement,
  createTutorZone,
  fakeFileBytes,
  getAuthHeaders,
  setPlatformSetting,
  setStudentLocation,
  setTutorLocation,
} from "../../tests/helpers.js";

type TestApp = Awaited<ReturnType<typeof createTestApp>>;

// A file in the fake bucket, so object removal can be checked.
async function storedFile(
  fake: ReturnType<typeof createFakeStorage>,
  ownerId: string,
  purpose: "CREDENTIAL" | "TUTOR_VIDEO" | "TUTOR_ID",
  overrides: { publishedAt?: Date | null } = {},
) {
  const key = `${purpose.toLowerCase()}/${crypto.randomUUID()}.bin`;
  const contentType = purpose === "TUTOR_VIDEO" ? "video/mp4" : "application/pdf";
  fake.put(key, fakeFileBytes(contentType, 64), contentType);
  return createFileAsset(ownerId, purpose, {
    storageKey: key,
    contentType,
    publishedAt: overrides.publishedAt,
  });
}

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

    it("rejects an inactive area the tutor does not have yet (409)", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      const tutor = await createTutorProfile(account.id);
      const inactive = await createArea({ isActive: false });

      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/tutors/me/areas",
        headers: await getAuthHeaders(account),
        payload: { areaIds: [inactive.id] },
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).code).toBe("AREA_OUTSIDE_CITY");
      expect(JSON.parse(res.body).details.invalidAreaIds).toEqual([inactive.id]);
      expect(await prisma.tutorArea.count({ where: { tutorId: tutor.id } })).toBe(0);
    });

    it("keeps an area that became inactive while the tutor already had it", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      await createTutorProfile(account.id);
      const headers = await getAuthHeaders(account);
      const area = await createArea();
      const added = await createArea();

      const first = await app.inject({
        method: "PUT",
        url: "/api/v1/tutors/me/areas",
        headers,
        payload: { areaIds: [area.id] },
      });
      expect(first.statusCode).toBe(200);
      await prisma.area.update({ where: { id: area.id }, data: { isActive: false } });

      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/tutors/me/areas",
        headers,
        payload: { areaIds: [area.id, added.id] },
      });

      expect(res.statusCode).toBe(200);
      const ids = JSON.parse(res.body).areas.map((a: { area: { id: number } }) => a.area.id);
      expect(ids.sort()).toEqual([area.id, added.id].sort());
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

    describe("packages", () => {
      async function profileWith(subjectCount: number) {
        const account = await createAccount({ role: "TUTOR" });
        const tutor = await createTutorProfile(account.id);
        const subjects = [];
        for (let i = 0; i < subjectCount; i++) subjects.push(await createSubject());
        await prisma.tutorSubject.createMany({
          data: subjects.map((s) => ({ tutorId: tutor.id, subjectId: s.id })),
        });
        return { tutor, subjects, headers: await getAuthHeaders(account) };
      }

      it("refuses when an OPEN package would lose its last subject (409) and lists it", async () => {
        const app = await createTestApp();
        const { tutor, subjects, headers } = await profileWith(2);
        const [s1, s2] = subjects;
        const pkg = await createTuitionPackage(tutor.id, { subjectIds: [s1.id] });

        const res = await app.inject({
          method: "PUT",
          url: "/api/v1/tutors/me/subjects",
          headers,
          payload: { subjectIds: [s2.id] },
        });

        expect(res.statusCode).toBe(409);
        const body = JSON.parse(res.body);
        expect(body.error).toBe("RequirementLosesLastSubject");
        expect(body.code).toBe("REQUIREMENT_LOSES_LAST_SUBJECT");
        expect(body.details).toEqual({ requirementIds: [], packageIds: [pkg.id] });
        expect(await prisma.tutorSubject.count({ where: { tutorId: tutor.id } })).toBe(2);
        expect(await prisma.packageSubject.count({ where: { packageId: pkg.id } })).toBe(1);
      });

      it("does not block when the package is CLOSED; its subject rows go with the profile subject", async () => {
        const app = await createTestApp();
        const { tutor, subjects, headers } = await profileWith(2);
        const [s1, s2] = subjects;
        const closed = await createTuitionPackage(tutor.id, {
          subjectIds: [s1.id],
          status: "CLOSED",
        });

        const res = await app.inject({
          method: "PUT",
          url: "/api/v1/tutors/me/subjects",
          headers,
          payload: { subjectIds: [s2.id] },
        });

        expect(res.statusCode).toBe(200);
        expect(await prisma.packageSubject.count({ where: { packageId: closed.id } })).toBe(0);
      });

      it("does not block when the package keeps another subject", async () => {
        const app = await createTestApp();
        const { tutor, subjects, headers } = await profileWith(2);
        const [s1, s2] = subjects;
        const pkg = await createTuitionPackage(tutor.id, { subjectIds: [s1.id, s2.id] });

        const res = await app.inject({
          method: "PUT",
          url: "/api/v1/tutors/me/subjects",
          headers,
          payload: { subjectIds: [s2.id] },
        });

        expect(res.statusCode).toBe(200);
        const rows = await prisma.packageSubject.findMany({ where: { packageId: pkg.id } });
        expect(rows.map((r) => r.subjectId)).toEqual([s2.id]);
      });
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
    const url = "/api/v1/tutors/me/verifications";

    async function setup(overrides: Parameters<typeof createTutorProfile>[1] = {}) {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      const tutor = await createTutorProfile(account.id, overrides);
      return { app, account, tutor, headers: await getAuthHeaders(account) };
    }

    function submit(app: TestApp, headers: Record<string, string>, fileId: string) {
      return app.inject({ method: "POST", url, headers, payload: { fileId } });
    }

    it("sends the ID for review and marks the tutor pending", async () => {
      const { app, account, tutor, headers } = await setup();
      const file = await createFileAsset(account.id, "TUTOR_ID");

      const res = await submit(app, headers, file.id);

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.status).toBe("PENDING");
      expect(body.file).toEqual({ id: file.id, status: "UPLOADED" });
      const rows = await prisma.tutorVerification.findMany({ where: { tutorId: tutor.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("PENDING");
      const updated = await prisma.tutor.findUniqueOrThrow({ where: { id: tutor.id } });
      expect(updated.verificationStatus).toBe("PENDING");
    });

    it("returns 404 without a tutor profile", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      const file = await createFileAsset(account.id, "TUTOR_ID");

      const res = await submit(app, await getAuthHeaders(account), file.id);

      expect(res.statusCode).toBe(404);
    });

    it("needs a student ID number on the profile (400)", async () => {
      const { app, account, tutor, headers } = await setup();
      await prisma.tutor.update({ where: { id: tutor.id }, data: { studentIdNumber: null } });
      const file = await createFileAsset(account.id, "TUTOR_ID");

      const res = await submit(app, headers, file.id);

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toBe(
        "Add your student ID number to your profile first.",
      );
    });

    it("refuses a second submission while under review (409)", async () => {
      const { app, account, headers } = await setup();
      const first = await createFileAsset(account.id, "TUTOR_ID");
      const second = await createFileAsset(account.id, "TUTOR_ID");
      await submit(app, headers, first.id);

      const res = await submit(app, headers, second.id);

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).code).toBe("INVALID_VERIFICATION_STATE");
      expect(JSON.parse(res.body).message).toBe("Your ID is already under review.");
    });

    it("refuses a submission once verified (409)", async () => {
      const { app, account, headers } = await setup({ verificationStatus: "APPROVED" });
      const file = await createFileAsset(account.id, "TUTOR_ID");

      const res = await submit(app, headers, file.id);

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).message).toBe("You're already verified.");
    });

    it("accepts a new ID after rejection", async () => {
      const { app, account, tutor, headers } = await setup();
      const first = await createFileAsset(account.id, "TUTOR_ID");
      const second = await createFileAsset(account.id, "TUTOR_ID");
      await submit(app, headers, first.id);
      await prisma.tutorVerification.updateMany({
        where: { tutorId: tutor.id },
        data: {
          status: "REJECTED",
          decidedAt: new Date(),
          note: "Blurry",
          reviewedById: (await createAdmin({ status: "ACTIVE" })).id,
        },
      });

      const res = await submit(app, headers, second.id);

      expect(res.statusCode).toBe(201);
      const updated = await prisma.tutor.findUniqueOrThrow({ where: { id: tutor.id } });
      expect(updated.verificationStatus).toBe("PENDING");
    });

    it("refuses a rejected file sent again (409 FILE_IN_USE)", async () => {
      const { app, account, tutor, headers } = await setup();
      const file = await createFileAsset(account.id, "TUTOR_ID");
      await submit(app, headers, file.id);
      await prisma.tutorVerification.updateMany({
        where: { tutorId: tutor.id },
        data: {
          status: "REJECTED",
          decidedAt: new Date(),
          note: "Blurry",
          reviewedById: (await createAdmin({ status: "ACTIVE" })).id,
        },
      });

      const res = await submit(app, headers, file.id);

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).code).toBe("FILE_IN_USE");
    });

    it("refuses someone else's file (400 INVALID_FILE)", async () => {
      const { app, headers } = await setup();
      const other = await createAccount({ role: "TUTOR" });
      const file = await createFileAsset(other.id, "TUTOR_ID");

      const res = await submit(app, headers, file.id);

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe("INVALID_FILE");
    });

    it("refuses a file uploaded for another purpose (400 INVALID_FILE)", async () => {
      const { app, account, headers } = await setup();
      const file = await createFileAsset(account.id, "CREDENTIAL");

      const res = await submit(app, headers, file.id);

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe("INVALID_FILE");
    });

    it("refuses a file that is still uploading (400 INVALID_FILE)", async () => {
      const { app, account, headers } = await setup();
      const file = await createFileAsset(account.id, "TUTOR_ID", { status: "PENDING_UPLOAD" });

      const res = await submit(app, headers, file.id);

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe("INVALID_FILE");
    });

    it("rejects a body without a fileId (400)", async () => {
      const { app, headers } = await setup();

      const res = await app.inject({ method: "POST", url, headers, payload: {} });

      expect(res.statusCode).toBe(400);
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

    describe("unlisted tutors", () => {
      const unlistedCache = "private, no-store";

      it("answers 404 with no-store to an anonymous caller", async () => {
        const app = await createTestApp();
        const account = await createAccount({ role: "TUTOR" });
        const tutor = await createTutorProfile(account.id, { isListed: false });

        const res = await app.inject({ method: "GET", url: `/api/v1/tutors/${tutor.id}` });

        expect(res.statusCode).toBe(404);
        expect(JSON.parse(res.body).message).toBe("Tutor not found");
        expect(res.headers["cache-control"]).toBe(unlistedCache);
      });

      it("answers 200 with no-store to the tutor who owns it", async () => {
        const app = await createTestApp();
        const account = await createAccount({ role: "TUTOR" });
        const tutor = await createTutorProfile(account.id, { isListed: false });
        const headers = await getAuthHeaders(account);

        const res = await app.inject({
          method: "GET",
          url: `/api/v1/tutors/${tutor.id}`,
          headers,
        });

        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body).tutor.id).toBe(tutor.id);
        expect(res.headers["cache-control"]).toBe(unlistedCache);
        expect(res.headers.vary).toBe("Authorization");
      });

      it("answers 200 to an ACTIVE admin", async () => {
        const app = await createTestApp();
        const account = await createAccount({ role: "TUTOR" });
        const tutor = await createTutorProfile(account.id, { isListed: false });
        const admin = await createAdmin();
        const headers = await getAuthHeaders(admin);

        const res = await app.inject({
          method: "GET",
          url: `/api/v1/tutors/${tutor.id}`,
          headers,
        });

        expect(res.statusCode).toBe(200);
        expect(res.headers["cache-control"]).toBe(unlistedCache);
      });

      it("answers 404 to a student with no application to the tutor", async () => {
        const app = await createTestApp();
        const area = await createArea();
        const account = await createAccount({ role: "TUTOR" });
        const tutor = await createTutorProfile(account.id, { isListed: false });
        const studentAccount = await createAccount({ role: "STUDENT" });
        await createStudentProfile(studentAccount.id, area.id);
        const headers = await getAuthHeaders(studentAccount);

        const res = await app.inject({
          method: "GET",
          url: `/api/v1/tutors/${tutor.id}`,
          headers,
        });

        expect(res.statusCode).toBe(404);
        expect(res.headers["cache-control"]).toBe(unlistedCache);
      });

      it("answers 200 to a student who has an application with the tutor", async () => {
        const app = await createTestApp();
        const area = await createArea();
        const account = await createAccount({ role: "TUTOR" });
        const tutor = await createTutorProfile(account.id, { isListed: false });
        const studentAccount = await createAccount({ role: "STUDENT" });
        const student = await createStudentProfile(studentAccount.id, area.id);
        const requirement = await createRequirement({ studentId: student.id });
        await createApplication({
          requirementId: requirement.id,
          tutorId: tutor.id,
          studentId: student.id,
          initiatedBy: "STUDENT",
        });
        const headers = await getAuthHeaders(studentAccount);

        const res = await app.inject({
          method: "GET",
          url: `/api/v1/tutors/${tutor.id}`,
          headers,
        });

        expect(res.statusCode).toBe(200);
        expect(res.headers["cache-control"]).toBe(unlistedCache);
      });

      it("keeps the public cache header for a listed tutor", async () => {
        const app = await createTestApp();
        const account = await createAccount({ role: "TUTOR" });
        const tutor = await createTutorProfile(account.id, { isListed: true });

        const res = await app.inject({ method: "GET", url: `/api/v1/tutors/${tutor.id}` });

        expect(res.statusCode).toBe(200);
        expect(res.headers["cache-control"]).toBe("public, max-age=60, stale-while-revalidate=300");
        expect(res.headers.vary).toBe("Authorization");
      });
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
    const url = "/api/v1/tutors/me/credentials";

    async function setup() {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      const tutor = await createTutorProfile(account.id);
      return { app, account, tutor, headers: await getAuthHeaders(account) };
    }

    it("adds a credential with its file", async () => {
      const { app, account, tutor, headers } = await setup();
      const file = await createFileAsset(account.id, "CREDENTIAL");

      const res = await app.inject({
        method: "POST",
        url,
        headers,
        payload: { examLabel: "  HSC  ", result: " A+ ", fileId: file.id },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.examLabel).toBe("HSC");
      expect(body.result).toBe("A+");
      expect(body.file).toEqual({ id: file.id, status: "UPLOADED" });
      expect(body).not.toHaveProperty("storageKey");
      const rows = await prisma.tutorCredential.findMany({ where: { tutorId: tutor.id } });
      expect(rows.map((r) => r.fileId)).toEqual([file.id]);
    });

    it("returns 404 without a tutor profile", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      const file = await createFileAsset(account.id, "CREDENTIAL");

      const res = await app.inject({
        method: "POST",
        url,
        headers: await getAuthHeaders(account),
        payload: { examLabel: "HSC", result: "A", fileId: file.id },
      });

      expect(res.statusCode).toBe(404);
    });

    it("rejects an empty exam label (400)", async () => {
      const { app, account, headers } = await setup();
      const file = await createFileAsset(account.id, "CREDENTIAL");

      const res = await app.inject({
        method: "POST",
        url,
        headers,
        payload: { examLabel: "   ", result: "A", fileId: file.id },
      });

      expect(res.statusCode).toBe(400);
    });

    it("refuses someone else's file (400 INVALID_FILE)", async () => {
      const { app, headers } = await setup();
      const other = await createAccount({ role: "TUTOR" });
      const file = await createFileAsset(other.id, "CREDENTIAL");

      const res = await app.inject({
        method: "POST",
        url,
        headers,
        payload: { examLabel: "HSC", result: "A", fileId: file.id },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe("INVALID_FILE");
    });

    it("refuses a file uploaded for another purpose (400 INVALID_FILE)", async () => {
      const { app, account, headers } = await setup();
      const file = await createFileAsset(account.id, "TUTOR_ID");

      const res = await app.inject({
        method: "POST",
        url,
        headers,
        payload: { examLabel: "HSC", result: "A", fileId: file.id },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe("INVALID_FILE");
    });

    it("refuses a file already attached to a credential (409 FILE_IN_USE)", async () => {
      const { app, account, headers } = await setup();
      const file = await createFileAsset(account.id, "CREDENTIAL");
      await app.inject({
        method: "POST",
        url,
        headers,
        payload: { examLabel: "HSC", result: "A", fileId: file.id },
      });

      const res = await app.inject({
        method: "POST",
        url,
        headers,
        payload: { examLabel: "SSC", result: "A+", fileId: file.id },
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).code).toBe("FILE_IN_USE");
    });

    it("allows at most 20 credentials (409 UPLOAD_LIMIT_REACHED)", async () => {
      const { app, account, tutor, headers } = await setup();
      const shared = await createFileAsset(account.id, "CREDENTIAL");
      await prisma.tutorCredential.createMany({
        data: Array.from({ length: 20 }, (_, i) => ({
          tutorId: tutor.id,
          examLabel: `Exam ${i}`,
          result: "A",
          fileId: shared.id,
        })),
      });
      const next = await createFileAsset(account.id, "CREDENTIAL");

      const res = await app.inject({
        method: "POST",
        url,
        headers,
        payload: { examLabel: "HSC", result: "A", fileId: next.id },
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).code).toBe("UPLOAD_LIMIT_REACHED");
      expect(JSON.parse(res.body).details).toEqual({ limit: 20 });
      expect(await prisma.tutorCredential.count({ where: { tutorId: tutor.id } })).toBe(20);
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
    const url = "/api/v1/tutors/me/videos";

    async function setup() {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      const tutor = await createTutorProfile(account.id);
      return { app, account, tutor, headers: await getAuthHeaders(account) };
    }

    it("adds a pending video in display order", async () => {
      const { app, account, tutor, headers } = await setup();
      const first = await createFileAsset(account.id, "TUTOR_VIDEO");
      const second = await createFileAsset(account.id, "TUTOR_VIDEO");

      const res = await app.inject({
        method: "POST",
        url,
        headers,
        payload: { title: "  Intro  ", fileId: first.id },
      });
      const next = await app.inject({
        method: "POST",
        url,
        headers,
        payload: { title: "Algebra", fileId: second.id },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.title).toBe("Intro");
      expect(body.status).toBe("PENDING");
      expect(body.moderationNote).toBeNull();
      expect(body.sortOrder).toBe(0);
      expect(body.url).toBeNull();
      expect(JSON.parse(next.body).sortOrder).toBe(1);
      const rows = await prisma.tutorVideo.findMany({ where: { tutorId: tutor.id } });
      expect(rows).toHaveLength(2);
    });

    it("returns a url for the new video when storage is configured", async () => {
      const fake = createFakeStorage();
      setStorageForTests(fake.storage);
      const { app, account, headers } = await setup();
      const file = await storedFile(fake, account.id, "TUTOR_VIDEO");

      const res = await app.inject({
        method: "POST",
        url,
        headers,
        payload: { title: "Intro", fileId: file.id },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.url).toContain(file.storageKey);
      expect(res.body).not.toContain('"storageKey"');
      setStorageForTests(null);
    });

    it("returns 404 without a tutor profile", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      const file = await createFileAsset(account.id, "TUTOR_VIDEO");

      const res = await app.inject({
        method: "POST",
        url,
        headers: await getAuthHeaders(account),
        payload: { title: "Intro", fileId: file.id },
      });

      expect(res.statusCode).toBe(404);
    });

    it("rejects an empty title (400)", async () => {
      const { app, account, headers } = await setup();
      const file = await createFileAsset(account.id, "TUTOR_VIDEO");

      const res = await app.inject({
        method: "POST",
        url,
        headers,
        payload: { title: "", fileId: file.id },
      });

      expect(res.statusCode).toBe(400);
    });

    it("refuses someone else's file (400 INVALID_FILE)", async () => {
      const { app, headers } = await setup();
      const other = await createAccount({ role: "TUTOR" });
      const file = await createFileAsset(other.id, "TUTOR_VIDEO");

      const res = await app.inject({
        method: "POST",
        url,
        headers,
        payload: { title: "Intro", fileId: file.id },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe("INVALID_FILE");
    });

    it("refuses a file uploaded for another purpose (400 INVALID_FILE)", async () => {
      const { app, account, headers } = await setup();
      const file = await createFileAsset(account.id, "CREDENTIAL");

      const res = await app.inject({
        method: "POST",
        url,
        headers,
        payload: { title: "Intro", fileId: file.id },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe("INVALID_FILE");
    });

    it("refuses a file that is still uploading (400 INVALID_FILE)", async () => {
      const { app, account, headers } = await setup();
      const file = await createFileAsset(account.id, "TUTOR_VIDEO", { status: "PENDING_UPLOAD" });

      const res = await app.inject({
        method: "POST",
        url,
        headers,
        payload: { title: "Intro", fileId: file.id },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe("INVALID_FILE");
    });

    it("refuses a file already attached to a video (409 FILE_IN_USE)", async () => {
      const { app, account, headers } = await setup();
      const file = await createFileAsset(account.id, "TUTOR_VIDEO");
      await app.inject({
        method: "POST",
        url,
        headers,
        payload: { title: "Intro", fileId: file.id },
      });

      const res = await app.inject({
        method: "POST",
        url,
        headers,
        payload: { title: "Again", fileId: file.id },
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).code).toBe("FILE_IN_USE");
    });

    it("allows at most 3 videos (409 UPLOAD_LIMIT_REACHED)", async () => {
      const { app, account, tutor, headers } = await setup();
      for (let i = 0; i < 3; i++) {
        const file = await createFileAsset(account.id, "TUTOR_VIDEO");
        await prisma.tutorVideo.create({
          data: { tutorId: tutor.id, fileId: file.id, title: `Video ${i}`, sortOrder: i },
        });
      }
      const next = await createFileAsset(account.id, "TUTOR_VIDEO");

      const res = await app.inject({
        method: "POST",
        url,
        headers,
        payload: { title: "Fourth", fileId: next.id },
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).code).toBe("UPLOAD_LIMIT_REACHED");
      expect(JSON.parse(res.body).details).toEqual({ limit: 3 });
      expect(await prisma.tutorVideo.count({ where: { tutorId: tutor.id } })).toBe(3);
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

  describe("admin notes shown to the tutor", () => {
    it("hides a note the admin did not share from the verification list", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      const tutor = await createTutorProfile(account.id);
      const admin = await createAdmin();
      const hidden = await createFileAsset(account.id, "TUTOR_ID");
      const visible = await createFileAsset(account.id, "TUTOR_ID");
      await prisma.tutorVerification.create({
        data: {
          tutorId: tutor.id,
          fileId: hidden.id,
          status: "REJECTED",
          reviewedById: admin.id,
          decidedAt: new Date("2026-01-01T00:00:00Z"),
          note: "Internal: name does not match the profile.",
          noteVisible: false,
          submittedAt: new Date("2026-01-01T00:00:00Z"),
        },
      });
      await prisma.tutorVerification.create({
        data: {
          tutorId: tutor.id,
          fileId: visible.id,
          status: "REJECTED",
          reviewedById: admin.id,
          decidedAt: new Date("2026-01-02T00:00:00Z"),
          note: "The photo is blurry.",
          noteVisible: true,
          submittedAt: new Date("2026-01-02T00:00:00Z"),
        },
      });
      const headers = await getAuthHeaders(account);

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/tutors/me/verifications",
        headers,
      });

      expect(res.statusCode).toBe(200);
      const [newest, older] = JSON.parse(res.body).verifications;
      expect(newest.note).toBe("The photo is blurry.");
      expect(older.note).toBeNull();
      expect(JSON.stringify(JSON.parse(res.body))).not.toContain("Internal:");
    });

    it("hides a moderation note the admin did not share from the owner video list", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      const tutor = await createTutorProfile(account.id);
      const hiddenFile = await createFileAsset(account.id, "TUTOR_VIDEO");
      const shownFile = await createFileAsset(account.id, "TUTOR_VIDEO");
      await prisma.tutorVideo.create({
        data: {
          tutorId: tutor.id,
          fileId: hiddenFile.id,
          title: "Hidden",
          status: "REJECTED",
          moderationNote: "Internal: looks like a stock clip.",
          noteVisible: false,
          sortOrder: 1,
        },
      });
      await prisma.tutorVideo.create({
        data: {
          tutorId: tutor.id,
          fileId: shownFile.id,
          title: "Shown",
          status: "REJECTED",
          moderationNote: "Audio is too quiet to hear.",
          noteVisible: true,
          sortOrder: 2,
        },
      });
      const headers = await getAuthHeaders(account);

      const res = await app.inject({ method: "GET", url: "/api/v1/tutors/me/videos", headers });

      expect(res.statusCode).toBe(200);
      const [hidden, shown] = JSON.parse(res.body).videos;
      expect(hidden).toMatchObject({ title: "Hidden", moderationNote: null });
      expect(shown).toMatchObject({
        title: "Shown",
        moderationNote: "Audio is too quiet to hear.",
      });
      expect(res.body).not.toContain("Internal:");
    });

    it("public video lists never carry a moderation note", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      const tutor = await createTutorProfile(account.id);
      const file = await createFileAsset(account.id, "TUTOR_VIDEO");
      await prisma.tutorVideo.create({
        data: {
          tutorId: tutor.id,
          fileId: file.id,
          title: "Approved",
          status: "APPROVED",
          moderationNote: "Shared note",
          noteVisible: true,
        },
      });

      const res = await app.inject({ method: "GET", url: "/api/v1/videos" });

      expect(res.statusCode).toBe(200);
      const [video] = JSON.parse(res.body).videos;
      expect(video).toBeDefined();
      expect(video).not.toHaveProperty("moderationNote");
      expect(res.body).not.toContain("Shared note");
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

    describe("zone or online rule", () => {
      it("rejects create that is offline with no zones (400 on zoneIds)", async () => {
        const app = await createTestApp();
        const { headers, subjects } = await setupTutor();

        const res = await app.inject({
          method: "POST",
          url: base,
          headers,
          payload: requirementPayload({ subjectIds: [subjects[0].id], teachesOnline: false }),
        });

        expect(res.statusCode).toBe(400);
        const body = JSON.parse(res.body);
        expect(body.code).toBe("VALIDATION_ERROR");
        expect(JSON.stringify(body)).toContain("zoneIds");
        expect(JSON.stringify(body)).toContain("Pick a zone or turn on online teaching");
      });

      it("creates an online set with no zones", async () => {
        const app = await createTestApp();
        const { headers, subjects } = await setupTutor();

        const res = await app.inject({
          method: "POST",
          url: base,
          headers,
          payload: requirementPayload({ subjectIds: [subjects[0].id], teachesOnline: true }),
        });

        expect(res.statusCode).toBe(201);
      });

      it("creates an offline set with a zone", async () => {
        const app = await createTestApp();
        const { headers, subjects, zoneIds } = await setupTutor(1, 1);

        const res = await app.inject({
          method: "POST",
          url: base,
          headers,
          payload: requirementPayload({
            subjectIds: [subjects[0].id],
            teachesOnline: false,
            zoneIds,
          }),
        });

        expect(res.statusCode).toBe(201);
      });

      async function offlineSet(withZone: boolean) {
        const ctx = await setupTutor(1, 1);
        const set = await createTutorRequirement(ctx.tutor.id, {
          isDefault: true,
          subjectIds: [ctx.subjects[0].id],
          zoneIds: withZone ? ctx.zoneIds : [],
        });
        return { ...ctx, set };
      }

      it("rejects turning online off on a set with no zones (400)", async () => {
        const app = await createTestApp();
        const { headers, set } = await offlineSet(false);

        const res = await app.inject({
          method: "PATCH",
          url: `${base}/${set.id}`,
          headers,
          payload: { teachesOnline: false },
        });

        expect(res.statusCode).toBe(400);
        const body = JSON.parse(res.body);
        expect(body.code).toBe("INVALID_REQUIREMENT");
        expect(body.message).toBe("Pick a zone or turn on online teaching");
        expect(body.details.fields).toEqual(["zoneIds"]);
        const row = await prisma.tutorRequirement.findUniqueOrThrow({ where: { id: set.id } });
        expect(row.teachesOnline).toBe(true);
      });

      it("rejects clearing every zone on an offline set (400)", async () => {
        const app = await createTestApp();
        const { headers, set } = await offlineSet(true);
        await prisma.tutorRequirement.update({
          where: { id: set.id },
          data: { teachesOnline: false },
        });

        const res = await app.inject({
          method: "PATCH",
          url: `${base}/${set.id}`,
          headers,
          payload: { zoneIds: [] },
        });

        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.body).code).toBe("INVALID_REQUIREMENT");
        expect(JSON.parse(res.body).details.fields).toEqual(["zoneIds"]);
        expect(await prisma.tutorRequirementZone.count({ where: { requirementId: set.id } })).toBe(
          1,
        );
      });

      it("allows turning online off when the set keeps a zone", async () => {
        const app = await createTestApp();
        const { headers, set } = await offlineSet(true);

        const res = await app.inject({
          method: "PATCH",
          url: `${base}/${set.id}`,
          headers,
          payload: { teachesOnline: false },
        });

        expect(res.statusCode).toBe(200);
      });

      it("allows clearing zones together with teachesOnline true", async () => {
        const app = await createTestApp();
        const { headers, set } = await offlineSet(true);
        await prisma.tutorRequirement.update({
          where: { id: set.id },
          data: { teachesOnline: false },
        });

        const res = await app.inject({
          method: "PATCH",
          url: `${base}/${set.id}`,
          headers,
          payload: { zoneIds: [], teachesOnline: true },
        });

        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body).zoneIds).toEqual([]);
      });
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

    it("archives a set while an OPEN package is listed (200); packages hold no set", async () => {
      const app = await createTestApp();
      const { tutor, headers, subjects } = await setupTutor();
      await createTutorRequirement(tutor.id, { isDefault: true });
      const set = await createTutorRequirement(tutor.id);
      const pkg = await createTuitionPackage(tutor.id, { subjectIds: [subjects[0].id] });

      const res = await app.inject({ method: "DELETE", url: `${base}/${set.id}`, headers });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).isActive).toBe(false);
      const pkgRow = await prisma.tuitionPackage.findUniqueOrThrow({ where: { id: pkg.id } });
      expect(pkgRow.status).toBe("OPEN");
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

    it("does not expose mappedPackageCount on a set", async () => {
      const app = await createTestApp();
      const { tutor, headers } = await setupTutor();
      await createTutorRequirement(tutor.id, { isDefault: true });

      const res = await app.inject({ method: "GET", url: base, headers });

      const sets: Record<string, unknown>[] = JSON.parse(res.body).requirements;
      expect(sets).toHaveLength(1);
      expect(sets[0]).not.toHaveProperty("mappedPackageCount");
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

    describe("daysPerWeek", () => {
      it("stores and returns daysPerWeek", async () => {
        const app = await createTestApp();
        const { headers, subjects } = await setupTutor();

        const res = await app.inject({
          method: "POST",
          url: base,
          headers,
          payload: requirementPayload({ daysPerWeek: 3, subjectIds: [subjects[0].id] }),
        });

        expect(res.statusCode).toBe(201);
        expect(JSON.parse(res.body).daysPerWeek).toBe(3);
      });

      it("returns null daysPerWeek when omitted", async () => {
        const app = await createTestApp();
        const { headers, subjects } = await setupTutor();

        const res = await app.inject({
          method: "POST",
          url: base,
          headers,
          payload: requirementPayload({ subjectIds: [subjects[0].id] }),
        });

        expect(res.statusCode).toBe(201);
        expect(JSON.parse(res.body).daysPerWeek).toBeNull();
      });

      it("rejects a daysPerWeek larger than the available days (400)", async () => {
        const app = await createTestApp();
        const { headers, subjects } = await setupTutor();

        const res = await app.inject({
          method: "POST",
          url: base,
          headers,
          payload: requirementPayload({
            daysPerWeek: 4,
            availableDays: 0b0000011,
            subjectIds: [subjects[0].id],
          }),
        });

        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.body).code).toBe("VALIDATION_ERROR");
      });

      it("clears daysPerWeek when PATCHed with null", async () => {
        const app = await createTestApp();
        const { headers, subjects } = await setupTutor();
        const created = await app.inject({
          method: "POST",
          url: base,
          headers,
          payload: requirementPayload({ daysPerWeek: 3, subjectIds: [subjects[0].id] }),
        });
        const id = JSON.parse(created.body).id;

        const res = await app.inject({
          method: "PATCH",
          url: `${base}/${id}`,
          headers,
          payload: { daysPerWeek: null },
        });

        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body).daysPerWeek).toBeNull();
      });

      it("rejects a PATCH that shrinks availableDays below daysPerWeek (400)", async () => {
        const app = await createTestApp();
        const { headers, subjects } = await setupTutor();
        const created = await app.inject({
          method: "POST",
          url: base,
          headers,
          payload: requirementPayload({ daysPerWeek: 5, subjectIds: [subjects[0].id] }),
        });
        const id = JSON.parse(created.body).id;

        const res = await app.inject({
          method: "PATCH",
          url: `${base}/${id}`,
          headers,
          payload: { availableDays: 0b0000011 },
        });

        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.body).error).toBe("InvalidRequirement");
        expect(JSON.parse(res.body).code).toBe("INVALID_REQUIREMENT");
      });
    });
  });
});

// A code verified for this account and number, as the OTP flow leaves it before the profile exists.
function verifiedOtp(accountId: string, phoneNumber: string, verifiedAt = new Date()) {
  return prisma.phoneOtp.create({
    data: {
      accountId,
      phoneNumber,
      codeHash: "test-hash",
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      verifiedAt,
    },
  });
}

describe("phone verification at tutor sign-up", () => {
  beforeEach(async () => {
    await setPlatformSetting("require_student_phone_verification", false);
    await setPlatformSetting("require_tutor_phone_verification", false);
  });

  it("creates an unverified profile when the tutor switch is off", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "TUTOR" });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/tutors/me",
      headers: await getAuthHeaders(account),
      payload: tutorPayload(),
    });

    expect(res.statusCode).toBe(201);
    const row = await prisma.tutor.findUniqueOrThrow({ where: { accountId: account.id } });
    expect(row.phoneVerifiedAt).toBeNull();
  });

  it("stamps the profile with a verified code and spends it when the switch is off", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "TUTOR" });
    const payload = tutorPayload();
    const otp = await verifiedOtp(account.id, payload.phoneNumber);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/tutors/me",
      headers: await getAuthHeaders(account),
      payload,
    });

    expect(res.statusCode).toBe(201);
    const row = await prisma.tutor.findUniqueOrThrow({ where: { accountId: account.id } });
    expect(row.phoneVerifiedAt).toEqual(otp.verifiedAt);
    const spent = await prisma.phoneOtp.findUniqueOrThrow({ where: { id: otp.id } });
    expect(spent.consumedAt).not.toBeNull();
  });

  describe("with the tutor switch on", () => {
    beforeEach(async () => {
      await setPlatformSetting("require_tutor_phone_verification", true);
    });

    it("refuses a profile without a verified code and creates nothing", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/tutors/me",
        headers: await getAuthHeaders(account),
        payload: tutorPayload(),
      });

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).code).toBe("PHONE_VERIFICATION_REQUIRED");
      expect(await prisma.tutor.findUnique({ where: { accountId: account.id } })).toBeNull();
    });

    it("accepts a code verified for this number", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      const payload = tutorPayload();
      const otp = await verifiedOtp(account.id, payload.phoneNumber);

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/tutors/me",
        headers: await getAuthHeaders(account),
        payload,
      });

      expect(res.statusCode).toBe(201);
      const row = await prisma.tutor.findUniqueOrThrow({ where: { accountId: account.id } });
      expect(row.phoneVerifiedAt).toEqual(otp.verifiedAt);
      const spent = await prisma.phoneOtp.findUniqueOrThrow({ where: { id: otp.id } });
      expect(spent.consumedAt).not.toBeNull();
    });

    it("refuses a code verified for a different number", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      await verifiedOtp(account.id, phone());

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/tutors/me",
        headers: await getAuthHeaders(account),
        payload: tutorPayload(),
      });

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).code).toBe("PHONE_VERIFICATION_REQUIRED");
      expect(await prisma.tutor.findUnique({ where: { accountId: account.id } })).toBeNull();
    });

    it("refuses a code verified more than 30 minutes ago", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });
      const payload = tutorPayload();
      await verifiedOtp(account.id, payload.phoneNumber, new Date(Date.now() - 31 * 60 * 1000));

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/tutors/me",
        headers: await getAuthHeaders(account),
        payload,
      });

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).code).toBe("PHONE_VERIFICATION_REQUIRED");
      expect(await prisma.tutor.findUnique({ where: { accountId: account.id } })).toBeNull();
    });

    it("does not block student sign-up", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "STUDENT" });
      const area = await createArea();

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/students/me",
        headers: await getAuthHeaders(account),
        payload: {
          name: "Student Name",
          areaId: area.id,
          address: "Student Address",
          emergencyContact: "+8801700000001",
          phoneNumber: phone(),
          studentIdNumber: `STU-${crypto.randomUUID()}`,
        },
      });

      expect(res.statusCode).toBe(201);
    });
  });
});

describe("phone verification when the tutor changes the number", () => {
  beforeEach(async () => {
    await setPlatformSetting("require_student_phone_verification", false);
    await setPlatformSetting("require_tutor_phone_verification", false);
  });

  // A verified profile, so a number change has a timestamp to lose.
  async function verifiedTutor() {
    const account = await createAccount({ role: "TUTOR" });
    await createTutorProfile(account.id);
    const verifiedAt = new Date(Date.now() - 60 * 1000);
    await prisma.tutor.update({
      where: { accountId: account.id },
      data: { phoneVerifiedAt: verifiedAt },
    });
    return { account, verifiedAt };
  }

  async function patchTutor(
    account: Awaited<ReturnType<typeof createAccount>>,
    payload: Record<string, unknown>,
  ) {
    const app = await createTestApp();
    return app.inject({
      method: "PATCH",
      url: "/api/v1/tutors/me",
      headers: await getAuthHeaders(account),
      payload,
    });
  }

  it("saves a new number verified when the switch is off and a code was verified for it", async () => {
    const { account } = await verifiedTutor();
    const newPhone = phone();
    const otp = await verifiedOtp(account.id, newPhone);

    const res = await patchTutor(account, { phoneNumber: newPhone });

    expect(res.statusCode).toBe(200);
    const row = await prisma.tutor.findUniqueOrThrow({ where: { accountId: account.id } });
    expect(row.phoneNumber).toBe(newPhone);
    expect(row.phoneVerifiedAt).toEqual(otp.verifiedAt);
    const spent = await prisma.phoneOtp.findUniqueOrThrow({ where: { id: otp.id } });
    expect(spent.consumedAt).not.toBeNull();
  });

  it("changes the number unverified when the switch is off and no code was verified", async () => {
    const { account } = await verifiedTutor();
    const newPhone = phone();

    const res = await patchTutor(account, { phoneNumber: newPhone });

    expect(res.statusCode).toBe(200);
    const row = await prisma.tutor.findUniqueOrThrow({ where: { accountId: account.id } });
    expect(row.phoneNumber).toBe(newPhone);
    expect(row.phoneVerifiedAt).toBeNull();
  });

  it("refuses a new number without a verified code when the switch is on", async () => {
    await setPlatformSetting("require_tutor_phone_verification", true);
    const { account, verifiedAt } = await verifiedTutor();
    const before = await prisma.tutor.findUniqueOrThrow({ where: { accountId: account.id } });

    const res = await patchTutor(account, { phoneNumber: phone() });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe("PHONE_VERIFICATION_REQUIRED");
    const row = await prisma.tutor.findUniqueOrThrow({ where: { accountId: account.id } });
    expect(row.phoneNumber).toBe(before.phoneNumber);
    expect(row.phoneVerifiedAt).toEqual(verifiedAt);
  });

  it("saves a new number verified when the switch is on and a code was verified for it", async () => {
    await setPlatformSetting("require_tutor_phone_verification", true);
    const { account } = await verifiedTutor();
    const newPhone = phone();
    const otp = await verifiedOtp(account.id, newPhone);

    const res = await patchTutor(account, { phoneNumber: newPhone });

    expect(res.statusCode).toBe(200);
    const row = await prisma.tutor.findUniqueOrThrow({ where: { accountId: account.id } });
    expect(row.phoneNumber).toBe(newPhone);
    expect(row.phoneVerifiedAt).toEqual(otp.verifiedAt);
  });

  it("keeps the verification when the same number is sent again", async () => {
    await setPlatformSetting("require_tutor_phone_verification", true);
    const { account, verifiedAt } = await verifiedTutor();
    const current = await prisma.tutor.findUniqueOrThrow({ where: { accountId: account.id } });

    const res = await patchTutor(account, { phoneNumber: current.phoneNumber });

    expect(res.statusCode).toBe(200);
    const row = await prisma.tutor.findUniqueOrThrow({ where: { accountId: account.id } });
    expect(row.phoneVerifiedAt).toEqual(verifiedAt);
  });

  it("leaves the verification alone when the body has no phone number, even with the switch on", async () => {
    await setPlatformSetting("require_tutor_phone_verification", true);
    const { account, verifiedAt } = await verifiedTutor();

    const res = await patchTutor(account, { name: "Renamed Tutor" });

    expect(res.statusCode).toBe(200);
    const row = await prisma.tutor.findUniqueOrThrow({ where: { accountId: account.id } });
    expect(row.name).toBe("Renamed Tutor");
    expect(row.phoneVerifiedAt).toEqual(verifiedAt);
  });
});

describe("home page consent for my videos", () => {
  async function approvedVideo() {
    const account = await createAccount({ role: "TUTOR" });
    const tutor = await createTutorProfile(account.id);
    const file = await createFileAsset(account.id, "TUTOR_VIDEO", { contentType: "video/mp4" });
    const video = await prisma.tutorVideo.create({
      data: { tutorId: tutor.id, fileId: file.id, title: "Algebra", status: "APPROVED" },
    });
    return { account, video, file };
  }

  async function patch(
    app: Awaited<ReturnType<typeof createTestApp>>,
    account: Parameters<typeof getAuthHeaders>[0],
    id: string,
    showOnHomePage: boolean,
  ) {
    return app.inject({
      method: "PATCH",
      url: `/api/v1/tutors/me/videos/${id}`,
      headers: await getAuthHeaders(account),
      payload: { showOnHomePage },
    });
  }

  it("shows showOnHomePage on my videos and sets it with PATCH", async () => {
    const app = await createTestApp();
    const { account, video } = await approvedVideo();

    const before = await app.inject({
      method: "GET",
      url: "/api/v1/tutors/me/videos",
      headers: await getAuthHeaders(account),
    });
    expect(JSON.parse(before.body).videos[0].showOnHomePage).toBe(false);

    const on = await patch(app, account, video.id, true);
    expect(on.statusCode).toBe(200);
    expect(JSON.parse(on.body)).toMatchObject({ id: video.id, showOnHomePage: true });
    expect(
      (await prisma.tutorVideo.findUniqueOrThrow({ where: { id: video.id } })).landingConsentAt,
    ).not.toBeNull();

    const off = await patch(app, account, video.id, false);
    expect(JSON.parse(off.body).showOnHomePage).toBe(false);
  });

  it("withdrawing consent takes the video off the landing page", async () => {
    const app = await createTestApp();
    const { account, video, file } = await approvedVideo();
    await prisma.tutorVideo.update({
      where: { id: video.id },
      data: { landingConsentAt: new Date() },
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

    const res = await patch(app, account, video.id, false);

    expect(res.statusCode).toBe(200);
    expect(await prisma.siteContent.count({ where: { key: "showcase" } })).toBe(0);
    expect(
      (await prisma.tutorVideo.findUniqueOrThrow({ where: { id: video.id } })).landingConsentAt,
    ).toBeNull();
  });

  it("answers 404 for another tutor's video", async () => {
    const app = await createTestApp();
    const { video } = await approvedVideo();
    const other = await createAccount({ role: "TUTOR" });
    await createTutorProfile(other.id);

    const res = await patch(app, other, video.id, true);

    expect(res.statusCode).toBe(404);
  });

  it("deleting a video takes its card off the landing page first", async () => {
    const app = await createTestApp();
    const { account, video, file } = await approvedVideo();
    await prisma.tutorVideo.update({
      where: { id: video.id },
      data: { landingConsentAt: new Date() },
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
      method: "DELETE",
      url: `/api/v1/tutors/me/videos/${video.id}`,
      headers: await getAuthHeaders(account),
    });

    expect(res.statusCode).toBe(204);
    expect(await prisma.siteContent.count({ where: { key: "showcase" } })).toBe(0);
  });
});
