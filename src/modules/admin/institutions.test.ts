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

const URL = "/api/v1/admin/institutions";

type AdminInstitution = {
  id: number;
  name: string;
  kind: string;
  district: string | null;
  area: string | null;
  aliases: string[];
  isActive: boolean;
  tutorCount: number;
  requirementCount: number;
};

// Unique tokens so the list filters never match seeded rows.
function tag() {
  return `Qzt${crypto.randomUUID().slice(0, 8)}`;
}

async function superAdminHeaders() {
  return getAuthHeaders(await createAdmin({ adminRole: "SUPER_ADMIN" }));
}

describe("admin institutions", () => {
  it("rejects a request without a token with 401", async () => {
    const app = await createTestApp();

    const res = await app.inject({ method: "GET", url: URL });

    expect(res.statusCode).toBe(401);
  });

  it("gives a plain admin 403 on every route", async () => {
    const app = await createTestApp();
    const headers = await getAuthHeaders(await createAdmin({ status: "ACTIVE" }));

    const list = await app.inject({ method: "GET", url: URL, headers });
    const create = await app.inject({
      method: "POST",
      url: URL,
      headers,
      payload: { name: tag(), kind: "SCHOOL" },
    });
    const id = (await prisma.institution.create({ data: { name: tag(), kind: "SCHOOL" } })).id;
    const patch = await app.inject({
      method: "PATCH",
      url: `${URL}/${id}`,
      headers,
      payload: { isActive: false },
    });

    expect([list.statusCode, create.statusCode, patch.statusCode]).toEqual([403, 403, 403]);
  });

  it("gives a student 403", async () => {
    const app = await createTestApp();
    const headers = await getAuthHeaders(await createAccount({ role: "STUDENT" }));

    const res = await app.inject({ method: "GET", url: URL, headers });

    expect(res.statusCode).toBe(403);
  });

  describe("POST", () => {
    it("creates an institution, trims the name, dedupes aliases and writes an audit row", async () => {
      const app = await createTestApp();
      const name = tag();

      const res = await app.inject({
        method: "POST",
        url: URL,
        headers: await superAdminHeaders(),
        payload: {
          name: `  ${name} College  `,
          kind: "COLLEGE",
          district: "Dhaka",
          area: "Mirpur",
          aliases: ["QC", "qc", "Mirpur College"],
        },
      });

      expect(res.statusCode).toBe(201);
      const created = JSON.parse(res.body) as AdminInstitution;
      expect(created).toMatchObject({
        name: `${name} College`,
        kind: "COLLEGE",
        district: "Dhaka",
        area: "Mirpur",
        aliases: ["QC", "Mirpur College"],
        isActive: true,
        tutorCount: 0,
        requirementCount: 0,
      });
      const audit = await prisma.auditLog.findFirst({
        where: { action: "institution.create", entityId: String(created.id) },
      });
      expect(audit?.entityType).toBe("institution");
    });

    it("answers 409 INSTITUTION_EXISTS for the same name in the same area, any letter case", async () => {
      const app = await createTestApp();
      const name = tag();
      await prisma.institution.create({ data: { name, kind: "SCHOOL", area: "Uttara" } });

      const res = await app.inject({
        method: "POST",
        url: URL,
        headers: await superAdminHeaders(),
        payload: { name: name.toUpperCase(), kind: "SCHOOL", area: "uttara" },
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body)).toMatchObject({
        code: "INSTITUTION_EXISTS",
        message: "This school or university is already on the list.",
      });
    });

    it("rejects an unknown field with 400", async () => {
      const app = await createTestApp();

      const res = await app.inject({
        method: "POST",
        url: URL,
        headers: await superAdminHeaders(),
        payload: { name: tag(), kind: "SCHOOL", popularity: 99 },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe("PATCH /:id", () => {
    it("renames, replaces aliases and deactivates", async () => {
      const app = await createTestApp();
      const row = await prisma.institution.create({
        data: { name: tag(), kind: "SCHOOL", aliases: ["Old"] },
      });

      const res = await app.inject({
        method: "PATCH",
        url: `${URL}/${row.id}`,
        headers: await superAdminHeaders(),
        payload: { name: `${row.name} Renamed`, aliases: ["New Name"], isActive: false },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({
        name: `${row.name} Renamed`,
        aliases: ["New Name"],
        isActive: false,
      });
      const audit = await prisma.auditLog.findFirst({
        where: { action: "institution.update", entityId: String(row.id) },
      });
      expect(audit?.before).toMatchObject({ isActive: true });
    });

    it("answers 404 for an unknown id", async () => {
      const app = await createTestApp();

      const res = await app.inject({
        method: "PATCH",
        url: `${URL}/999999`,
        headers: await superAdminHeaders(),
        payload: { isActive: false },
      });

      expect(res.statusCode).toBe(404);
    });

    it("answers 409 when the rename clashes with another row", async () => {
      const app = await createTestApp();
      const taken = tag();
      await prisma.institution.create({ data: { name: taken, kind: "SCHOOL" } });
      const row = await prisma.institution.create({ data: { name: tag(), kind: "SCHOOL" } });

      const res = await app.inject({
        method: "PATCH",
        url: `${URL}/${row.id}`,
        headers: await superAdminHeaders(),
        payload: { name: taken },
      });

      expect(res.statusCode).toBe(409);
    });

    it("rejects an empty body with 400", async () => {
      const app = await createTestApp();
      const row = await prisma.institution.create({ data: { name: tag(), kind: "SCHOOL" } });

      const res = await app.inject({
        method: "PATCH",
        url: `${URL}/${row.id}`,
        headers: await superAdminHeaders(),
        payload: {},
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe("GET /", () => {
    it("filters by q, kind and status, and pages with total", async () => {
      const app = await createTestApp();
      const token = tag();
      await prisma.institution.createMany({
        data: [
          { name: `${token} One`, kind: "SCHOOL" },
          { name: `${token} Two`, kind: "SCHOOL" },
          { name: `${token} Three`, kind: "UNIVERSITY", isActive: false },
        ],
      });
      const headers = await superAdminHeaders();

      const all = await app.inject({ method: "GET", url: `${URL}?q=${token}`, headers });
      expect(JSON.parse(all.body)).toMatchObject({ total: 3 });

      const schools = await app.inject({
        method: "GET",
        url: `${URL}?q=${token}&kind=SCHOOL`,
        headers,
      });
      expect(JSON.parse(schools.body)).toMatchObject({ total: 2 });

      const inactive = await app.inject({
        method: "GET",
        url: `${URL}?q=${token}&status=inactive`,
        headers,
      });
      const inactiveBody = JSON.parse(inactive.body) as {
        institutions: AdminInstitution[];
        total: number;
      };
      expect(inactiveBody.total).toBe(1);
      expect(inactiveBody.institutions[0]?.name).toBe(`${token} Three`);

      const page = await app.inject({
        method: "GET",
        url: `${URL}?q=${token}&limit=2&offset=2`,
        headers,
      });
      const pageBody = JSON.parse(page.body) as { institutions: AdminInstitution[]; total: number };
      expect(pageBody.total).toBe(3);
      // Sorted by name: One, Three, Two.
      expect(pageBody.institutions.map((i) => i.name)).toEqual([`${token} Two`]);
    });

    it("finds a row by its alias and by its EIIN", async () => {
      const app = await createTestApp();
      const token = tag();
      await prisma.institution.create({
        data: {
          name: `${token} School`,
          kind: "SCHOOL",
          aliases: [`${token} Alias`],
          eiin: `${token}E`,
        },
      });
      const headers = await superAdminHeaders();

      const byAlias = await app.inject({
        method: "GET",
        url: `${URL}?q=${encodeURIComponent(`${token} Alias`)}`,
        headers,
      });
      const byEiin = await app.inject({ method: "GET", url: `${URL}?q=${token}E`, headers });

      expect(JSON.parse(byAlias.body)).toMatchObject({ total: 1 });
      expect(JSON.parse(byEiin.body)).toMatchObject({ total: 1 });
    });
  });
});

describe("admin institutions: name rules and rename", () => {
  it("rejects a name with no letters or digits (400)", async () => {
    const app = await createTestApp();

    const res = await app.inject({
      method: "POST",
      url: URL,
      headers: await superAdminHeaders(),
      payload: { name: "...--", kind: "SCHOOL" },
    });

    expect(res.statusCode).toBe(400);
  });

  it("rejects a one-character alias (400)", async () => {
    const app = await createTestApp();

    const res = await app.inject({
      method: "POST",
      url: URL,
      headers: await superAdminHeaders(),
      payload: { name: tag(), kind: "SCHOOL", aliases: ["A"] },
    });

    expect(res.statusCode).toBe(400);
  });

  it("a rename sets the new name on every linked tutor and requirement", async () => {
    const app = await createTestApp();
    const row = await prisma.institution.create({ data: { name: tag(), kind: "COLLEGE" } });
    const tutor = await createTutorProfile((await createAccount({ role: "TUTOR" })).id, {
      instituteName: row.name,
    });
    await prisma.tutor.update({ where: { id: tutor.id }, data: { institutionId: row.id } });
    const student = await createStudentProfile(
      (await createAccount({ role: "STUDENT" })).id,
      (await createArea()).id,
    );
    const requirement = await createRequirement({ studentId: student.id, status: "DRAFT" });
    await prisma.tuitionRequirement.update({
      where: { id: requirement.id },
      data: { institutionId: row.id, instituteName: row.name },
    });

    const res = await app.inject({
      method: "PATCH",
      url: `${URL}/${row.id}`,
      headers: await superAdminHeaders(),
      payload: { name: `${row.name} Renamed` },
    });

    expect(res.statusCode).toBe(200);
    expect((await prisma.tutor.findUniqueOrThrow({ where: { id: tutor.id } })).instituteName).toBe(
      `${row.name} Renamed`,
    );
    expect(
      (await prisma.tuitionRequirement.findUniqueOrThrow({ where: { id: requirement.id } }))
        .instituteName,
    ).toBe(`${row.name} Renamed`);
  });
});
