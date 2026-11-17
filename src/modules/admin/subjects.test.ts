import { describe, expect, it } from "vitest";
import { prisma } from "../../lib/prisma.js";
import {
  createAccount,
  createAdmin,
  createTestApp,
  createTutorProfile,
  getAuthHeaders,
} from "../../tests/helpers.js";

const URL = "/api/v1/admin/subjects";
const PUBLIC_URL = "/api/v1/subjects";

type AdminSubject = {
  id: number;
  name: string;
  slug: string;
  sortOrder: number;
  isActive: boolean;
  tutorCount: number;
};

async function addSubject(data: {
  name: string;
  slug: string;
  sortOrder?: number;
  isActive?: boolean;
}) {
  return prisma.subject.create({ data });
}

describe("admin subjects", () => {
  describe("GET /api/v1/admin/subjects", () => {
    it("rejects a request without a token with 401", async () => {
      const app = await createTestApp();

      const res = await app.inject({ method: "GET", url: URL });

      expect(res.statusCode).toBe(401);
    });

    it("rejects a student token with 403", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "STUDENT" });

      const res = await app.inject({
        method: "GET",
        url: URL,
        headers: await getAuthHeaders(account),
      });

      expect(res.statusCode).toBe(403);
    });

    it("lists inactive subjects too, sorted by sortOrder then name, with tutorCount", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const math = await addSubject({ name: "Math", slug: "math", sortOrder: 2 });
      await addSubject({ name: "Bangla", slug: "bangla", sortOrder: 1 });
      await addSubject({ name: "Physics", slug: "physics", sortOrder: 2, isActive: false });
      await addSubject({ name: "Chemistry", slug: "chemistry", sortOrder: 1 });
      const tutor = await createTutorProfile((await createAccount({ role: "TUTOR" })).id);
      await prisma.tutorSubject.create({ data: { tutorId: tutor.id, subjectId: math.id } });

      const res = await app.inject({
        method: "GET",
        url: URL,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(200);
      const subjects = (JSON.parse(res.body) as { subjects: AdminSubject[] }).subjects;
      expect(subjects.map((s) => s.name)).toEqual(["Bangla", "Chemistry", "Math", "Physics"]);
      expect(subjects.find((s) => s.name === "Physics")?.isActive).toBe(false);
      expect(subjects.find((s) => s.name === "Math")?.tutorCount).toBe(1);
      expect(subjects.find((s) => s.name === "Bangla")?.tutorCount).toBe(0);
    });
  });

  describe("POST /api/v1/admin/subjects", () => {
    it("rejects a request without a token with 401", async () => {
      const app = await createTestApp();

      const res = await app.inject({ method: "POST", url: URL, payload: { name: "Music" } });

      expect(res.statusCode).toBe(401);
    });

    it("rejects a PENDING admin with 403", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "PENDING" });

      const res = await app.inject({
        method: "POST",
        url: URL,
        headers: await getAuthHeaders(admin),
        payload: { name: "Music" },
      });

      expect(res.statusCode).toBe(403);
    });

    it("creates a subject with a slug derived from the name and returns 201", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });

      const res = await app.inject({
        method: "POST",
        url: URL,
        headers: await getAuthHeaders(admin),
        payload: { name: "  Higher Math 2 " },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body) as AdminSubject;
      expect(body).toEqual({
        id: expect.any(Number),
        name: "Higher Math 2",
        slug: "higher-math-2",
        sortOrder: 0,
        isActive: true,
        tutorCount: 0,
      });
    });

    it("keeps an explicit slug and sortOrder", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });

      const res = await app.inject({
        method: "POST",
        url: URL,
        headers: await getAuthHeaders(admin),
        payload: { name: "English Literature", slug: "eng-lit", sortOrder: 40 },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body) as AdminSubject;
      expect(body.slug).toBe("eng-lit");
      expect(body.sortOrder).toBe(40);
    });

    it("writes a subject.create audit row", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });

      const res = await app.inject({
        method: "POST",
        url: URL,
        headers: await getAuthHeaders(admin),
        payload: { name: "Music" },
      });
      const body = JSON.parse(res.body) as AdminSubject;

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: "subject.create", entityType: "subject", entityId: String(body.id) },
      });
      expect(audit.actorAccountId).toBe(admin.id);
      expect(audit.after).toEqual({ name: "Music", slug: "music", sortOrder: 0, isActive: true });
    });

    it("returns 409 SUBJECT_EXISTS for a duplicate name, ignoring case", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      await addSubject({ name: "Biology", slug: "biology" });

      const res = await app.inject({
        method: "POST",
        url: URL,
        headers: await getAuthHeaders(admin),
        payload: { name: "biology", slug: "bio-2" },
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).code).toBe("SUBJECT_EXISTS");
    });

    it("returns 409 SUBJECT_EXISTS for a duplicate slug", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      await addSubject({ name: "Physics", slug: "physics" });

      const res = await app.inject({
        method: "POST",
        url: URL,
        headers: await getAuthHeaders(admin),
        payload: { name: "Physics Lab", slug: "physics" },
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).code).toBe("SUBJECT_EXISTS");
    });

    it("returns 400 on slug when the name leaves nothing to build a slug from", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });

      const res = await app.inject({
        method: "POST",
        url: URL,
        headers: await getAuthHeaders(admin),
        payload: { name: "!!" },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.code).toBe("VALIDATION_ERROR");
      expect(body.issues[0].path).toEqual(["slug"]);
    });

    it("rejects an explicit slug that is not lowercase kebab case", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });

      const res = await app.inject({
        method: "POST",
        url: URL,
        headers: await getAuthHeaders(admin),
        payload: { name: "Music", slug: "Music Club" },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe("VALIDATION_ERROR");
    });
  });

  describe("PATCH /api/v1/admin/subjects/:id", () => {
    it("rejects a request without a token with 401", async () => {
      const app = await createTestApp();
      const subject = await addSubject({ name: "Art", slug: "art" });

      const res = await app.inject({
        method: "PATCH",
        url: `${URL}/${subject.id}`,
        payload: { isActive: false },
      });

      expect(res.statusCode).toBe(401);
    });

    it("renames and re-sorts a subject and records before and after", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const subject = await addSubject({ name: "Math", slug: "math", sortOrder: 0 });

      const res = await app.inject({
        method: "PATCH",
        url: `${URL}/${subject.id}`,
        headers: await getAuthHeaders(admin),
        payload: { name: "Mathematics", sortOrder: 5 },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as AdminSubject;
      expect(body).toMatchObject({
        id: subject.id,
        name: "Mathematics",
        slug: "math",
        sortOrder: 5,
      });

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: "subject.update", entityId: String(subject.id) },
      });
      expect(audit.actorAccountId).toBe(admin.id);
      expect(audit.before).toEqual({ name: "Math", sortOrder: 0 });
      expect(audit.after).toEqual({ name: "Mathematics", sortOrder: 5 });
    });

    it("keeps the subject when only the case of its own name changes", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const subject = await addSubject({ name: "Math", slug: "math" });

      const res = await app.inject({
        method: "PATCH",
        url: `${URL}/${subject.id}`,
        headers: await getAuthHeaders(admin),
        payload: { name: "MATH" },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).name).toBe("MATH");
    });

    it("returns 404 for an unknown subject", async () => {
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

    it("returns 400 when no field is sent", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const subject = await addSubject({ name: "Art", slug: "art" });

      const res = await app.inject({
        method: "PATCH",
        url: `${URL}/${subject.id}`,
        headers: await getAuthHeaders(admin),
        payload: {},
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe("VALIDATION_ERROR");
    });

    it("returns 409 SUBJECT_EXISTS when renamed onto another subject's name", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      await addSubject({ name: "Alpha", slug: "alpha" });
      const beta = await addSubject({ name: "Beta", slug: "beta" });

      const res = await app.inject({
        method: "PATCH",
        url: `${URL}/${beta.id}`,
        headers: await getAuthHeaders(admin),
        payload: { name: "alpha" },
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).code).toBe("SUBJECT_EXISTS");
    });

    it("returns 409 SUBJECT_EXISTS when re-slugged onto another subject's slug", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      await addSubject({ name: "Alpha", slug: "alpha" });
      const beta = await addSubject({ name: "Beta", slug: "beta" });

      const res = await app.inject({
        method: "PATCH",
        url: `${URL}/${beta.id}`,
        headers: await getAuthHeaders(admin),
        payload: { slug: "alpha" },
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).code).toBe("SUBJECT_EXISTS");
    });

    it("deactivating hides the subject from GET /subjects, but tutors keep it", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const headers = await getAuthHeaders(admin);
      const subject = await addSubject({ name: "Drawing", slug: "drawing" });
      const tutor = await createTutorProfile((await createAccount({ role: "TUTOR" })).id);
      await prisma.tutorSubject.create({ data: { tutorId: tutor.id, subjectId: subject.id } });

      const before = await app.inject({ method: "GET", url: PUBLIC_URL });
      expect(JSON.parse(before.body).subjects.map((s: { id: number }) => s.id)).toContain(
        subject.id,
      );

      const res = await app.inject({
        method: "PATCH",
        url: `${URL}/${subject.id}`,
        headers,
        payload: { isActive: false },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({ isActive: false, tutorCount: 1 });

      const after = await app.inject({ method: "GET", url: PUBLIC_URL });
      expect(JSON.parse(after.body).subjects.map((s: { id: number }) => s.id)).not.toContain(
        subject.id,
      );
      const stillTaught = await prisma.tutorSubject.count({ where: { subjectId: subject.id } });
      expect(stillTaught).toBe(1);
    });
  });
});
