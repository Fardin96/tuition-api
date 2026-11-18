import { describe, expect, it } from "vitest";
import { prisma } from "../../lib/prisma.js";
import {
  createAccount,
  createAdmin,
  createArea,
  createRequirement,
  createStudentProfile,
  createTestApp,
  createTutorProfile,
  getAuthHeaders,
} from "../../tests/helpers.js";

const URL = "/api/v1/admin/areas";

type AdminArea = {
  id: number;
  name: string;
  division: string;
  district: string;
  districtCode: string | null;
  isActive: boolean;
  tutorCount: number;
  studentCount: number;
  requirementCount: number;
};

type AdminAreaList = {
  areas: AdminArea[];
  districts: { code: string; name: string; division: string }[];
};

describe("admin areas", () => {
  describe("GET /api/v1/admin/areas", () => {
    it("rejects a request without a token with 401", async () => {
      const app = await createTestApp();

      const res = await app.inject({ method: "GET", url: URL });

      expect(res.statusCode).toBe(401);
    });

    it("rejects a tutor token with 403", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "TUTOR" });

      const res = await app.inject({
        method: "GET",
        url: URL,
        headers: await getAuthHeaders(account),
      });

      expect(res.statusCode).toBe(403);
    });

    it("lists inactive areas too, with tutor, student and requirement counts", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const mirpur = await createArea({ name: "Mirpur", district: "Dhaka", division: "Dhaka" });
      await createArea({
        name: "Old Town",
        district: "Dhaka",
        division: "Dhaka",
        isActive: false,
      });
      const tutor = await createTutorProfile((await createAccount({ role: "TUTOR" })).id);
      await prisma.tutorArea.create({ data: { tutorId: tutor.id, areaId: mirpur.id } });
      const student = await createStudentProfile(
        (await createAccount({ role: "STUDENT" })).id,
        mirpur.id,
      );
      await createStudentProfile((await createAccount({ role: "STUDENT" })).id, mirpur.id);
      await createRequirement({ studentId: student.id, areaId: mirpur.id });

      const res = await app.inject({
        method: "GET",
        url: URL,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe("private, no-store");
      const { areas } = JSON.parse(res.body) as AdminAreaList;
      expect(areas.map((a) => a.name)).toEqual(["Mirpur", "Old Town"]);
      expect(areas.find((a) => a.name === "Old Town")?.isActive).toBe(false);
      expect(areas.find((a) => a.name === "Mirpur")).toMatchObject({
        tutorCount: 1,
        studentCount: 2,
        requirementCount: 1,
        districtCode: "dhaka",
      });
    });

    it("lists all 64 districts for the create form, sorted by division then name", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });

      const res = await app.inject({
        method: "GET",
        url: URL,
        headers: await getAuthHeaders(admin),
      });

      const { districts } = JSON.parse(res.body) as AdminAreaList;
      expect(districts).toHaveLength(64);
      expect(districts).toContainEqual({
        code: "coxsbazar",
        name: "Cox's Bazar",
        division: "Chattogram",
      });
      const sorted = [...districts].sort(
        (a, b) => a.division.localeCompare(b.division) || a.name.localeCompare(b.name),
      );
      expect(districts).toEqual(sorted);
    });

    it("filters by districtCode, q and isActive", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const headers = await getAuthHeaders(admin);
      await createArea({ name: "Kolatoli", district: "Cox's Bazar", division: "Chattogram" });
      await createArea({ name: "Mirpur", district: "Dhaka", division: "Dhaka" });
      await createArea({
        name: "Gulshan",
        district: "Dhaka",
        division: "Dhaka",
        isActive: false,
      });

      const byDistrict = await app.inject({
        method: "GET",
        url: `${URL}?districtCode=coxsbazar`,
        headers,
      });
      expect(byDistrict.statusCode).toBe(200);
      expect((JSON.parse(byDistrict.body) as AdminAreaList).areas.map((a) => a.name)).toEqual([
        "Kolatoli",
      ]);

      const byQuery = await app.inject({ method: "GET", url: `${URL}?q=MIR`, headers });
      expect((JSON.parse(byQuery.body) as AdminAreaList).areas.map((a) => a.name)).toEqual([
        "Mirpur",
      ]);

      const inactive = await app.inject({ method: "GET", url: `${URL}?isActive=false`, headers });
      expect((JSON.parse(inactive.body) as AdminAreaList).areas.map((a) => a.name)).toEqual([
        "Gulshan",
      ]);
    });

    it("returns 400 for an unknown districtCode", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });

      const res = await app.inject({
        method: "GET",
        url: `${URL}?districtCode=nowhere`,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe("VALIDATION_ERROR");
    });
  });

  describe("POST /api/v1/admin/areas", () => {
    it("rejects a request without a token with 401", async () => {
      const app = await createTestApp();

      const res = await app.inject({
        method: "POST",
        url: URL,
        payload: { districtCode: "dhaka", name: "Mirpur" },
      });

      expect(res.statusCode).toBe(401);
    });

    it("rejects a PENDING admin with 403", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "PENDING" });

      const res = await app.inject({
        method: "POST",
        url: URL,
        headers: await getAuthHeaders(admin),
        payload: { districtCode: "dhaka", name: "Mirpur" },
      });

      expect(res.statusCode).toBe(403);
    });

    it("creates an area with division and district from districtCode and returns 201", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });

      const res = await app.inject({
        method: "POST",
        url: URL,
        headers: await getAuthHeaders(admin),
        payload: { districtCode: "coxsbazar", name: "  Kolatoli " },
      });

      expect(res.statusCode).toBe(201);
      expect(JSON.parse(res.body)).toEqual({
        id: expect.any(Number),
        name: "Kolatoli",
        division: "Chattogram",
        district: "Cox's Bazar",
        districtCode: "coxsbazar",
        isActive: true,
        tutorCount: 0,
        studentCount: 0,
        requirementCount: 0,
      });
    });

    it("writes an area.create audit row", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });

      const res = await app.inject({
        method: "POST",
        url: URL,
        headers: await getAuthHeaders(admin),
        payload: { districtCode: "dhaka", name: "Mirpur" },
      });
      const body = JSON.parse(res.body) as AdminArea;

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: "area.create", entityType: "area", entityId: String(body.id) },
      });
      expect(audit.actorAccountId).toBe(admin.id);
      expect(audit.after).toEqual({
        name: "Mirpur",
        division: "Dhaka",
        district: "Dhaka",
        isActive: true,
      });
    });

    it("returns 409 AREA_EXISTS for a duplicate name in the same district, ignoring case", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      await createArea({ name: "Kolatoli", district: "Cox's Bazar", division: "Chattogram" });

      const res = await app.inject({
        method: "POST",
        url: URL,
        headers: await getAuthHeaders(admin),
        payload: { districtCode: "coxsbazar", name: "kolatoli" },
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).code).toBe("AREA_EXISTS");
    });

    it("allows the same name in another district", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      await createArea({ name: "Kolatoli", district: "Cox's Bazar", division: "Chattogram" });

      const res = await app.inject({
        method: "POST",
        url: URL,
        headers: await getAuthHeaders(admin),
        payload: { districtCode: "dhaka", name: "Kolatoli" },
      });

      expect(res.statusCode).toBe(201);
      expect(JSON.parse(res.body).district).toBe("Dhaka");
    });

    it("returns 400 for an unknown districtCode", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });

      const res = await app.inject({
        method: "POST",
        url: URL,
        headers: await getAuthHeaders(admin),
        payload: { districtCode: "nowhere", name: "Mirpur" },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe("VALIDATION_ERROR");
    });
  });

  describe("PATCH /api/v1/admin/areas/:id", () => {
    it("rejects a request without a token with 401", async () => {
      const app = await createTestApp();
      const area = await createArea({ name: "Mirpur" });

      const res = await app.inject({
        method: "PATCH",
        url: `${URL}/${area.id}`,
        payload: { isActive: false },
      });

      expect(res.statusCode).toBe(401);
    });

    it("renames an area and records before and after", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const area = await createArea({ name: "Mirpur", district: "Dhaka", division: "Dhaka" });

      const res = await app.inject({
        method: "PATCH",
        url: `${URL}/${area.id}`,
        headers: await getAuthHeaders(admin),
        payload: { name: "Mirpur 10" },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({
        id: area.id,
        name: "Mirpur 10",
        district: "Dhaka",
        division: "Dhaka",
      });

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: "area.update", entityType: "area", entityId: String(area.id) },
      });
      expect(audit.actorAccountId).toBe(admin.id);
      expect(audit.before).toEqual({ name: "Mirpur" });
      expect(audit.after).toEqual({ name: "Mirpur 10" });
    });

    it("deactivating keeps the area on students, tutors and requirements", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const headers = await getAuthHeaders(admin);
      const area = await createArea({ name: "Mirpur", district: "Dhaka", division: "Dhaka" });
      const student = await createStudentProfile(
        (await createAccount({ role: "STUDENT" })).id,
        area.id,
      );
      await createRequirement({ studentId: student.id, areaId: area.id });

      const res = await app.inject({
        method: "PATCH",
        url: `${URL}/${area.id}`,
        headers,
        payload: { isActive: false },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({
        isActive: false,
        studentCount: 1,
        requirementCount: 1,
      });

      const list = await app.inject({ method: "GET", url: URL, headers });
      expect((JSON.parse(list.body) as AdminAreaList).areas.map((a) => a.id)).toContain(area.id);
      const stillUsed = await prisma.student.count({ where: { areaId: area.id } });
      expect(stillUsed).toBe(1);
    });

    it("does not write an audit row when nothing changes", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const area = await createArea({ name: "Mirpur", district: "Dhaka", division: "Dhaka" });

      const res = await app.inject({
        method: "PATCH",
        url: `${URL}/${area.id}`,
        headers: await getAuthHeaders(admin),
        payload: { name: "Mirpur", isActive: true },
      });

      expect(res.statusCode).toBe(200);
      const count = await prisma.auditLog.count({
        where: { action: "area.update", entityId: String(area.id) },
      });
      expect(count).toBe(0);
    });

    it("returns 400 when district is sent, because district is not editable", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const area = await createArea({ name: "Mirpur", district: "Dhaka", division: "Dhaka" });

      const res = await app.inject({
        method: "PATCH",
        url: `${URL}/${area.id}`,
        headers: await getAuthHeaders(admin),
        payload: { district: "Gazipur" },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe("VALIDATION_ERROR");
    });

    it("returns 400 when division is sent, because division is not editable", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const area = await createArea({ name: "Mirpur", district: "Dhaka", division: "Dhaka" });

      const res = await app.inject({
        method: "PATCH",
        url: `${URL}/${area.id}`,
        headers: await getAuthHeaders(admin),
        payload: { division: "Khulna" },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe("VALIDATION_ERROR");
    });

    it("returns 400 when no field is sent", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const area = await createArea({ name: "Mirpur" });

      const res = await app.inject({
        method: "PATCH",
        url: `${URL}/${area.id}`,
        headers: await getAuthHeaders(admin),
        payload: {},
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe("VALIDATION_ERROR");
    });

    it("returns 404 for an unknown area", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });

      const res = await app.inject({
        method: "PATCH",
        url: `${URL}/999999`,
        headers: await getAuthHeaders(admin),
        payload: { isActive: false },
      });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).code).toBe("NOT_FOUND");
    });

    it("returns 409 AREA_EXISTS when renamed onto another area's name in the same district", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      await createArea({ name: "Alpha", district: "Dhaka", division: "Dhaka" });
      const beta = await createArea({ name: "Beta", district: "Dhaka", division: "Dhaka" });

      const res = await app.inject({
        method: "PATCH",
        url: `${URL}/${beta.id}`,
        headers: await getAuthHeaders(admin),
        payload: { name: "alpha" },
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).code).toBe("AREA_EXISTS");
    });
  });
});
