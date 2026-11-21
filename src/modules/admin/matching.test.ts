import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Account } from "../../generated/prisma/client.js";
import { prisma } from "../../lib/prisma.js";
import {
  createAccount,
  createAdmin,
  createArea,
  createRequirement,
  createStudentProfile,
  createSubject,
  createSuperAdmin,
  createTestApp,
  createTutorProfile,
  createTutorRequirement,
  getAuthHeaders,
  setStudentLocation,
  setTutorLocation,
} from "../../tests/helpers.js";
import {
  DEFAULT_MATCHING_CONFIG,
  type MatchingConfigInput,
  RULE_IDS,
} from "../matching/matching-config.js";

const CONFIG_URL = "/api/v1/admin/matching/config";
const PREVIEW_URL = "/api/v1/admin/matching/preview";
const EXPLAIN_URL = "/api/v1/admin/matching/explain";
const UNMATCHED_URL = "/api/v1/admin/matching/unmatched";
const CITIES_URL = "/api/v1/admin/cities";

// Inside Dhaka city (Gulshan), and Savar: outside the city, about 8 km from its western edge.
const DHAKA = { lat: 23.8103, lng: 90.4125 };
const SAVAR = { lat: 23.8583, lng: 90.2667 };

// A 3 km by 3 km square near Chattogram: about 10 km2.
const SQUARE = [
  [
    [91.82, 22.32],
    [91.85, 22.32],
    [91.85, 22.35],
    [91.82, 22.35],
    [91.82, 22.32],
  ],
];

// The defaults as a PUT or preview body: no version, which the server sets.
function configInput(edit?: (input: MatchingConfigInput) => void): MatchingConfigInput {
  const { version: _version, ...rest } = DEFAULT_MATCHING_CONFIG;
  const input = structuredClone(rest);
  edit?.(input);
  return input;
}

type Problem = { code: string; issues?: { path: (string | number)[]; message: string }[] };

// One OPEN home-tuition requirement in Dhaka and one listed tutor whose only set matches it.
async function matchFixture(
  opts: {
    tutorGender?: "MALE" | "FEMALE";
    requirementGender?: "ANY" | "MALE" | "FEMALE";
    tutorLocation?: { lat: number; lng: number };
  } = {},
) {
  const area = await createArea();
  const subject = await createSubject();
  const studentAccount = await createAccount({ role: "STUDENT" });
  const student = await createStudentProfile(studentAccount.id, area.id);
  await setStudentLocation(student.id, DHAKA);
  const requirement = await createRequirement({
    studentId: student.id,
    areaId: area.id,
    subjectId: subject.id,
    tutorGenderPref: opts.requirementGender ?? "ANY",
  });

  const tutorAccount = await createAccount({ role: "TUTOR" });
  const tutor = await createTutorProfile(tutorAccount.id, {
    isListed: true,
    gender: opts.tutorGender ?? "MALE",
  });
  await setTutorLocation(tutor.id, opts.tutorLocation ?? DHAKA);
  // A set can only use subjects on the tutor's profile.
  await prisma.tutorSubject.create({ data: { tutorId: tutor.id, subjectId: subject.id } });
  const set = await createTutorRequirement(tutor.id, {
    isDefault: true,
    subjectIds: [subject.id],
  });
  // An online-only set (no zones) cannot teach at home; this set teaches at the tutor's pin.
  await prisma.tutorRequirement.update({ where: { id: set.id }, data: { teachesOnline: false } });

  return { area, subject, student, requirement, tutor, set };
}

// Creates the test city "testville". Tests never write the dhaka row.
async function createTestCity(app: Awaited<ReturnType<typeof createTestApp>>, superAdmin: Account) {
  const res = await app.inject({
    method: "PUT",
    url: `${CITIES_URL}/testville`,
    headers: await getAuthHeaders(superAdmin),
    payload: {
      name: "Test Ville",
      districtCode: "chattogram",
      boundary: { type: "Polygon", coordinates: SQUARE },
    },
  });
  expect(res.statusCode).toBe(200);
}

describe("admin matching", () => {
  describe("GET /api/v1/admin/matching/config", () => {
    it("rejects a request without a token with 401", async () => {
      const app = await createTestApp();

      const res = await app.inject({ method: "GET", url: CONFIG_URL });

      expect(res.statusCode).toBe(401);
    });

    it("rejects a student token with 403", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "STUDENT" });

      const res = await app.inject({
        method: "GET",
        url: CONFIG_URL,
        headers: await getAuthHeaders(account),
      });

      expect(res.statusCode).toBe(403);
    });

    it("returns the defaults at version 0 when no config has been saved", async () => {
      const app = await createTestApp();
      const admin = await createAdmin();

      const res = await app.inject({
        method: "GET",
        url: CONFIG_URL,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.config.version).toBe(0);
      expect(body.config.rules.curriculum).toEqual({ mode: "REQUIRED", weight: 3 });
      expect(body.defaults).toEqual(body.config);
      expect(body.updatedAt).toBeNull();
      expect(body.updatedByName).toBeNull();
      expect(body.ruleModes.quality).toEqual(["RANK", "OFF"]);
      expect(Object.keys(body.config.rules).sort()).toEqual([...RULE_IDS].sort());
    });
  });

  describe("PUT /api/v1/admin/matching/config", () => {
    it("saves the rules as a super admin, bumps the version and writes an audit row", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();

      const res = await app.inject({
        method: "PUT",
        url: CONFIG_URL,
        headers: await getAuthHeaders(superAdmin),
        payload: configInput((input) => {
          input.cityEdgeKm = 1.5;
          input.rules.gender.weight = 2;
        }),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.config.version).toBe(1);
      expect(body.config.cityEdgeKm).toBe(1.5);
      expect(body.config.rules.gender.weight).toBe(2);
      expect(body.updatedByName).not.toBeNull();

      const audit = await prisma.auditLog.findFirst({ where: { action: "matching.update" } });
      expect(audit?.entityId).toBe("matching_config");
      expect(audit?.actorAccountId).toBe(superAdmin.id);

      const again = await app.inject({
        method: "GET",
        url: CONFIG_URL,
        headers: await getAuthHeaders(superAdmin),
      });
      expect(JSON.parse(again.body).config.version).toBe(1);
    });

    it("rejects a plain admin with 403 and saves nothing", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });

      const res = await app.inject({
        method: "PUT",
        url: CONFIG_URL,
        headers: await getAuthHeaders(admin),
        payload: configInput((input) => {
          input.cityEdgeKm = 1;
        }),
      });

      expect(res.statusCode).toBe(403);
      expect(
        await prisma.platformSetting.findUnique({ where: { key: "matching_config" } }),
      ).toBeNull();
    });

    it("refuses a curriculum rule that is OFF with 400", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();

      const res = await app.inject({
        method: "PUT",
        url: CONFIG_URL,
        headers: await getAuthHeaders(superAdmin),
        payload: configInput((input) => {
          input.rules.curriculum.mode = "OFF";
        }),
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body) as Problem;
      expect(body.code).toBe("VALIDATION_ERROR");
      expect(body.issues?.[0]?.path).toEqual(["rules", "curriculum", "mode"]);
    });

    it("refuses a curriculum listed in two equivalence groups with 400", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();

      const res = await app.inject({
        method: "PUT",
        url: CONFIG_URL,
        headers: await getAuthHeaders(superAdmin),
        payload: configInput((input) => {
          input.curriculumEquivalents = [
            ["BANGLA_MEDIUM", "ENGLISH_VERSION"],
            ["ENGLISH_VERSION", "MADRASAH"],
          ];
        }),
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe("VALIDATION_ERROR");
    });
  });

  describe("POST /api/v1/admin/matching/preview", () => {
    it("counts the requirements and tutors under the saved and the posted config", async () => {
      const app = await createTestApp();
      const admin = await createAdmin();
      await matchFixture();

      const res = await app.inject({
        method: "POST",
        url: PREVIEW_URL,
        headers: await getAuthHeaders(admin),
        payload: { config: configInput() },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.current.version).toBe(0);
      expect(body.draft.version).toBe(body.current.version);
      for (const side of [body.current, body.draft]) {
        expect(side.openRequirements).toBe(1);
        expect(side.requirementsWithNoTutor).toBe(0);
        expect(side.requirementsWithFewTutors).toBe(1);
        expect(side.requirementsWithManyTutors).toBe(0);
        expect(side.listedTutors).toBe(1);
        expect(side.tutorsWithAMatch).toBe(1);
      }
    });

    it("shows the draft apart from the saved config when gender stops being required", async () => {
      const app = await createTestApp();
      const admin = await createAdmin();
      // The requirement wants a male tutor; the tutor is female, so only a relaxed gender rule matches.
      await matchFixture({ tutorGender: "FEMALE", requirementGender: "MALE" });

      const res = await app.inject({
        method: "POST",
        url: PREVIEW_URL,
        headers: await getAuthHeaders(admin),
        payload: {
          config: configInput((input) => {
            input.rules.gender.mode = "OFF";
          }),
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.current.requirementsWithNoTutor).toBe(1);
      expect(body.current.tutorsWithAMatch).toBe(0);
      expect(body.draft.requirementsWithNoTutor).toBe(0);
      expect(body.draft.requirementsWithFewTutors).toBe(1);
      expect(body.draft.tutorsWithAMatch).toBe(1);
    });
  });

  describe("GET /api/v1/admin/matching/explain", () => {
    it("returns every set of the tutor with the parts of every rule", async () => {
      const app = await createTestApp();
      const admin = await createAdmin();
      const { requirement, tutor, set } = await matchFixture();

      const res = await app.inject({
        method: "GET",
        url: `${EXPLAIN_URL}?requirementId=${requirement.id}&tutorId=${tutor.id}`,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.version).toBe(0);
      expect(body.requirement.curriculum).toBe("BANGLA_MEDIUM");
      expect(body.requirement.status).toBe("OPEN");
      expect(body.tutor).toEqual({ id: tutor.id, name: tutor.name, isListed: true });
      expect(body.sets).toHaveLength(1);
      expect(body.sets[0].setId).toBe(set.id);
      expect(body.sets[0].isDefault).toBe(true);
      expect(body.sets[0].parts.passes).toBe(true);
      expect(body.sets[0].parts.reach).toBe(true);
      expect(Object.keys(body.sets[0].parts.rules).sort()).toEqual([...RULE_IDS].sort());
      expect(body.sets[0].parts.rules.curriculum).toEqual({
        mode: "REQUIRED",
        pass: true,
        part: 1,
      });
    });

    it("returns 404 for an unknown requirement or an unknown tutor", async () => {
      const app = await createTestApp();
      const admin = await createAdmin();
      const { requirement, tutor } = await matchFixture();
      const headers = await getAuthHeaders(admin);
      const unknown = crypto.randomUUID();

      const noRequirement = await app.inject({
        method: "GET",
        url: `${EXPLAIN_URL}?requirementId=${unknown}&tutorId=${tutor.id}`,
        headers,
      });
      const noTutor = await app.inject({
        method: "GET",
        url: `${EXPLAIN_URL}?requirementId=${requirement.id}&tutorId=${unknown}`,
        headers,
      });

      expect(noRequirement.statusCode).toBe(404);
      expect(noTutor.statusCode).toBe(404);
    });
  });

  describe("GET /api/v1/admin/matching/unmatched", () => {
    it("lists an old open requirement with no matching tutor, with the blocker that keeps it empty", async () => {
      const app = await createTestApp();
      const admin = await createAdmin();
      // The only tutor lives in Savar: a student in the city cannot reach it, and nothing else fails.
      const { requirement, subject, student } = await matchFixture({ tutorLocation: SAVAR });
      await prisma.tuitionRequirement.update({
        where: { id: requirement.id },
        data: { createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000) },
      });
      // A new requirement is left out of the 24 hour default.
      const fresh = await createRequirement({ studentId: student.id, subjectId: subject.id });

      const res = await app.inject({
        method: "GET",
        url: `${UNMATCHED_URL}?olderThanHours=24`,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.requirements).toHaveLength(1);
      expect(body.requirements[0]).toMatchObject({
        id: requirement.id,
        studentName: student.name,
        curriculum: "BANGLA_MEDIUM",
        levelCode: 10,
        subjectIds: [subject.id],
        tuitionType: "Home Tutoring Solo",
        blockers: ["reach"],
      });
      expect(body.requirements.map((r: { id: string }) => r.id)).not.toContain(fresh.id);
    });

    it("rejects an hours value above 720 with 400", async () => {
      const app = await createTestApp();
      const admin = await createAdmin();

      const res = await app.inject({
        method: "GET",
        url: `${UNMATCHED_URL}?olderThanHours=721`,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe("cities", () => {
    it("lists dhaka with an area between 250 and 350 km2", async () => {
      const app = await createTestApp();
      const admin = await createAdmin();

      const res = await app.inject({
        method: "GET",
        url: CITIES_URL,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(200);
      const dhaka = JSON.parse(res.body).cities.find(
        (city: { slug: string }) => city.slug === "dhaka",
      );
      expect(dhaka).toMatchObject({ name: "Dhaka", districtCode: "dhaka", isActive: true });
      expect(dhaka.areaKm2).toBeGreaterThan(250);
      expect(dhaka.areaKm2).toBeLessThan(350);
    });

    it("creates a city from a valid polygon as a super admin and writes an audit row", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();

      const res = await app.inject({
        method: "PUT",
        url: `${CITIES_URL}/testville`,
        headers: await getAuthHeaders(superAdmin),
        payload: {
          name: "Test Ville",
          districtCode: "chattogram",
          boundary: { type: "Polygon", coordinates: SQUARE },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toMatchObject({
        slug: "testville",
        name: "Test Ville",
        districtCode: "chattogram",
        isActive: true,
      });
      expect(body.areaKm2).toBeGreaterThan(5);
      expect(body.areaKm2).toBeLessThan(20);
      expect(body.boundary).toBeUndefined();

      const row = await prisma.city.findUnique({ where: { slug: "testville" } });
      expect(row).not.toBeNull();
      const audit = await prisma.auditLog.findFirst({
        where: { action: "city.upsert", entityId: "testville" },
      });
      expect(audit?.actorAccountId).toBe(superAdmin.id);
    });

    it("refuses a self-intersecting boundary with 400 on the boundary path", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();
      // A bow-tie: the two diagonals cross.
      const bowTie = [
        [
          [91.82, 22.32],
          [91.85, 22.35],
          [91.85, 22.32],
          [91.82, 22.35],
          [91.82, 22.32],
        ],
      ];

      const res = await app.inject({
        method: "PUT",
        url: `${CITIES_URL}/testville`,
        headers: await getAuthHeaders(superAdmin),
        payload: {
          name: "Test Ville",
          districtCode: "chattogram",
          boundary: { type: "Polygon", coordinates: bowTie },
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body) as Problem;
      expect(body.code).toBe("VALIDATION_ERROR");
      expect(body.issues?.[0]?.path).toEqual(["boundary"]);
      expect(await prisma.city.findUnique({ where: { slug: "testville" } })).toBeNull();
    });

    it("refuses a polygon under 5 km2 with 400", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();
      // About 0.1 km on a side.
      const tiny = [
        [
          [91.82, 22.32],
          [91.821, 22.32],
          [91.821, 22.321],
          [91.82, 22.321],
          [91.82, 22.32],
        ],
      ];

      const res = await app.inject({
        method: "PUT",
        url: `${CITIES_URL}/testville`,
        headers: await getAuthHeaders(superAdmin),
        payload: {
          name: "Test Ville",
          districtCode: "chattogram",
          boundary: { type: "Polygon", coordinates: tiny },
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body) as Problem;
      expect(body.issues?.[0]?.path).toEqual(["boundary"]);
    });

    it("maps a PostGIS rejection (a ring with two points) to 400 on the boundary path", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();

      const res = await app.inject({
        method: "PUT",
        url: `${CITIES_URL}/testville`,
        headers: await getAuthHeaders(superAdmin),
        payload: {
          name: "Test Ville",
          districtCode: "chattogram",
          boundary: {
            type: "Polygon",
            coordinates: [
              [
                [91.82, 22.32],
                [91.85, 22.35],
              ],
            ],
          },
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body) as Problem;
      expect(body.code).toBe("VALIDATION_ERROR");
      expect(body.issues?.[0]?.path).toEqual(["boundary"]);
    });

    it("deactivates a city with PATCH and keeps it when a later PUT omits isActive", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();
      const headers = await getAuthHeaders(superAdmin);
      await createTestCity(app, superAdmin);

      const res = await app.inject({
        method: "PATCH",
        url: `${CITIES_URL}/testville`,
        headers,
        payload: { isActive: false },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({ slug: "testville", isActive: false });
      const row = await prisma.city.findUnique({ where: { slug: "testville" } });
      expect(row?.isActive).toBe(false);
      const audit = await prisma.auditLog.findFirst({
        where: { action: "city.update", entityId: "testville" },
      });
      expect(audit).not.toBeNull();

      const reput = await app.inject({
        method: "PUT",
        url: `${CITIES_URL}/testville`,
        headers,
        payload: {
          name: "Test Ville",
          districtCode: "chattogram",
          boundary: { type: "Polygon", coordinates: SQUARE },
        },
      });
      expect(reput.statusCode).toBe(200);
      expect(JSON.parse(reput.body).isActive).toBe(false);
    });

    it("returns 404 when PATCH names an unknown city", async () => {
      const app = await createTestApp();
      const superAdmin = await createSuperAdmin();

      const res = await app.inject({
        method: "PATCH",
        url: `${CITIES_URL}/nosuchcity`,
        headers: await getAuthHeaders(superAdmin),
        payload: { isActive: false },
      });

      expect(res.statusCode).toBe(404);
    });

    it("refuses a city write from a plain admin with 403", async () => {
      const app = await createTestApp();
      const admin = await createAdmin();

      const res = await app.inject({
        method: "PUT",
        url: `${CITIES_URL}/testville`,
        headers: await getAuthHeaders(admin),
        payload: {
          name: "Test Ville",
          districtCode: "chattogram",
          boundary: { type: "Polygon", coordinates: SQUARE },
        },
      });

      expect(res.statusCode).toBe(403);
    });
  });
});
