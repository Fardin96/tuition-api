import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { prisma } from "../../lib/prisma.js";
import {
  createAccount,
  createAdmin,
  createArea,
  createStudentProfile,
  createSubject,
  createTestApp,
  createTuitionPackage,
  createTutorProfile,
  createTutorRequirement,
  getAuthHeaders,
  setTutorLocation,
} from "../../tests/helpers.js";

const LIST_URL = "/api/v1/admin/packages";
const PACKAGES_URL = "/api/v1/packages";

async function setupTutor(isListed = false) {
  const account = await createAccount({ role: "TUTOR" });
  const tutor = await createTutorProfile(account.id, { isListed });
  return { account, tutor };
}

async function setupStudent() {
  const account = await createAccount({ role: "STUDENT" });
  const area = await createArea();
  await createStudentProfile(account.id, area.id);
  return account;
}

describe("admin package moderation", () => {
  describe("GET /api/v1/admin/packages", () => {
    it("rejects requests without a token with 401", async () => {
      const app = await createTestApp();

      const res = await app.inject({ method: "GET", url: LIST_URL });

      expect(res.statusCode).toBe(401);
    });

    it("rejects students, tutors and pending admins with 403", async () => {
      const app = await createTestApp();
      const student = await createAccount({ role: "STUDENT" });
      const tutor = await createAccount({ role: "TUTOR" });
      const pendingAdmin = await createAdmin({ status: "PENDING" });

      for (const account of [student, tutor, pendingAdmin]) {
        const res = await app.inject({
          method: "GET",
          url: LIST_URL,
          headers: await getAuthHeaders(account),
        });
        expect(res.statusCode).toBe(403);
      }
    });

    it("lists only PENDING packages by default, oldest first", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const { tutor } = await setupTutor();

      const newest = await createTuitionPackage(tutor.id, {
        moderationStatus: "PENDING",
        createdAt: new Date("2026-03-03T00:00:00Z"),
      });
      const oldest = await createTuitionPackage(tutor.id, {
        moderationStatus: "PENDING",
        createdAt: new Date("2026-03-01T00:00:00Z"),
      });
      const middle = await createTuitionPackage(tutor.id, {
        moderationStatus: "PENDING",
        createdAt: new Date("2026-03-02T00:00:00Z"),
      });
      await createTuitionPackage(tutor.id, { moderationStatus: "APPROVED" });

      const res = await app.inject({
        method: "GET",
        url: LIST_URL,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.packages.map((p: { id: string }) => p.id)).toEqual([
        oldest.id,
        middle.id,
        newest.id,
      ]);
      expect(body.nextCursor).toBeNull();
      expect(body.packages[0]).toMatchObject({
        moderationStatus: "PENDING",
        moderationNote: null,
        tutor: { id: tutor.id, verificationStatus: "NOT_SUBMITTED", isListed: false },
      });
    });

    it("filters by listing status", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const { tutor } = await setupTutor();
      await createTuitionPackage(tutor.id, { moderationStatus: "PENDING", status: "OPEN" });
      const closed = await createTuitionPackage(tutor.id, {
        moderationStatus: "PENDING",
        status: "CLOSED",
      });

      const res = await app.inject({
        method: "GET",
        url: `${LIST_URL}?status=CLOSED`,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.packages.map((p: { id: string }) => p.id)).toEqual([closed.id]);
    });

    it("lists APPROVED packages newest first and pages with nextCursor", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const { tutor } = await setupTutor();

      const oldest = await createTuitionPackage(tutor.id, {
        moderationStatus: "APPROVED",
        createdAt: new Date("2026-04-01T00:00:00Z"),
      });
      const middle = await createTuitionPackage(tutor.id, {
        moderationStatus: "APPROVED",
        createdAt: new Date("2026-04-02T00:00:00Z"),
      });
      const newest = await createTuitionPackage(tutor.id, {
        moderationStatus: "APPROVED",
        createdAt: new Date("2026-04-03T00:00:00Z"),
      });
      const headers = await getAuthHeaders(admin);

      const page1 = await app.inject({
        method: "GET",
        url: `${LIST_URL}?moderationStatus=APPROVED&limit=2`,
        headers,
      });
      expect(page1.statusCode).toBe(200);
      const body1 = JSON.parse(page1.body);
      expect(body1.packages.map((p: { id: string }) => p.id)).toEqual([newest.id, middle.id]);
      expect(body1.nextCursor).toEqual(expect.any(String));

      const page2 = await app.inject({
        method: "GET",
        url: `${LIST_URL}?moderationStatus=APPROVED&limit=2&cursor=${encodeURIComponent(body1.nextCursor)}`,
        headers,
      });
      expect(page2.statusCode).toBe(200);
      const body2 = JSON.parse(page2.body);
      expect(body2.packages.map((p: { id: string }) => p.id)).toEqual([oldest.id]);
      expect(body2.nextCursor).toBeNull();
    });
  });

  describe("GET /api/v1/admin/packages/:id", () => {
    it("returns the package with its moderation and tutor review fields", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const { tutor } = await setupTutor(true);
      const pkg = await createTuitionPackage(tutor.id, {
        moderationStatus: "REJECTED",
        moderationNote: "Describe the syllabus",
      });

      const res = await app.inject({
        method: "GET",
        url: `${LIST_URL}/${pkg.id}`,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({
        id: pkg.id,
        moderationStatus: "REJECTED",
        moderationNote: "Describe the syllabus",
        updatedAt: expect.any(String),
        tutor: { id: tutor.id, verificationStatus: "APPROVED", isListed: true },
      });
    });

    it("returns 404 for an unknown id", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });

      const res = await app.inject({
        method: "GET",
        url: `${LIST_URL}/${crypto.randomUUID()}`,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).code).toBe("NOT_FOUND");
    });
  });

  describe("POST /api/v1/admin/packages/:id/moderate", () => {
    it("rejects students with 403", async () => {
      const app = await createTestApp();
      const { tutor } = await setupTutor();
      const pkg = await createTuitionPackage(tutor.id, { moderationStatus: "PENDING" });
      const student = await createAccount({ role: "STUDENT" });

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${pkg.id}/moderate`,
        headers: await getAuthHeaders(student),
        payload: { decision: "APPROVE" },
      });

      expect(res.statusCode).toBe(403);
    });

    it("approve sets APPROVED and makes the package visible to students", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const { tutor } = await setupTutor(true);
      const pkg = await createTuitionPackage(tutor.id, { moderationStatus: "PENDING" });
      const student = await setupStudent();
      const studentHeaders = await getAuthHeaders(student);

      const before = await app.inject({
        method: "GET",
        url: `${PACKAGES_URL}/${pkg.id}`,
        headers: studentHeaders,
      });
      expect(before.statusCode).toBe(404);

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${pkg.id}/moderate`,
        headers: await getAuthHeaders(admin),
        payload: { decision: "APPROVE" },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({
        id: pkg.id,
        moderationStatus: "APPROVED",
        moderationNote: null,
      });

      const row = await prisma.tuitionPackage.findUniqueOrThrow({ where: { id: pkg.id } });
      expect(row.moderationStatus).toBe("APPROVED");

      const after = await app.inject({
        method: "GET",
        url: `${PACKAGES_URL}/${pkg.id}`,
        headers: studentHeaders,
      });
      expect(after.statusCode).toBe(200);
      expect(JSON.parse(after.body).moderationStatus).toBe("APPROVED");
    });

    it("rejects without a note with 400", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const { tutor } = await setupTutor();
      const pkg = await createTuitionPackage(tutor.id, { moderationStatus: "PENDING" });

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${pkg.id}/moderate`,
        headers: await getAuthHeaders(admin),
        payload: { decision: "REJECT" },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe("VALIDATION_ERROR");
      const row = await prisma.tuitionPackage.findUniqueOrThrow({ where: { id: pkg.id } });
      expect(row.moderationStatus).toBe("PENDING");
    });

    it("reject with a note sets REJECTED and stores the note", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const { tutor } = await setupTutor();
      const pkg = await createTuitionPackage(tutor.id, { moderationStatus: "PENDING" });

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${pkg.id}/moderate`,
        headers: await getAuthHeaders(admin),
        payload: { decision: "REJECT", note: "  Add the syllabus outline  " },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({
        moderationStatus: "REJECTED",
        moderationNote: "Add the syllabus outline",
      });
      const row = await prisma.tuitionPackage.findUniqueOrThrow({ where: { id: pkg.id } });
      expect(row.moderationStatus).toBe("REJECTED");
      expect(row.moderationNote).toBe("Add the syllabus outline");
    });

    it("a second decision gets 409 PACKAGE_ALREADY_MODERATED", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const { tutor } = await setupTutor();
      const pkg = await createTuitionPackage(tutor.id, { moderationStatus: "PENDING" });
      const headers = await getAuthHeaders(admin);

      const first = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${pkg.id}/moderate`,
        headers,
        payload: { decision: "APPROVE" },
      });
      expect(first.statusCode).toBe(200);

      const second = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${pkg.id}/moderate`,
        headers,
        payload: { decision: "REJECT", note: "Changed my mind" },
      });

      expect(second.statusCode).toBe(409);
      expect(JSON.parse(second.body).code).toBe("PACKAGE_ALREADY_MODERATED");
      const row = await prisma.tuitionPackage.findUniqueOrThrow({ where: { id: pkg.id } });
      expect(row.moderationStatus).toBe("APPROVED");
      expect(row.moderationNote).toBeNull();
    });

    it("returns 404 for an unknown id", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${crypto.randomUUID()}/moderate`,
        headers: await getAuthHeaders(admin),
        payload: { decision: "APPROVE" },
      });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).code).toBe("NOT_FOUND");
    });

    it("writes an audit row with the before and after state", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const { tutor } = await setupTutor();
      const pkg = await createTuitionPackage(tutor.id, { moderationStatus: "PENDING" });

      const res = await app.inject({
        method: "POST",
        url: `${LIST_URL}/${pkg.id}/moderate`,
        headers: await getAuthHeaders(admin),
        payload: { decision: "REJECT", note: "Too short" },
      });
      expect(res.statusCode).toBe(200);

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { entityType: "tuition_package", entityId: pkg.id, action: "package.moderate" },
      });
      expect(audit.actorAccountId).toBe(admin.id);
      expect(audit.before).toEqual({ moderationStatus: "PENDING" });
      expect(audit.after).toEqual({ moderationStatus: "REJECTED", note: "Too short" });
    });
  });

  describe("tutor flow", () => {
    // A tutor that passes the apply gate, listed so students can see its packages. Same setup as
    // package-write.test.ts.
    async function createReadyTutor() {
      const account = await createAccount({ role: "TUTOR" });
      const tutor = await createTutorProfile(account.id, { isListed: true });
      await setTutorLocation(tutor.id);
      const area = await createArea();
      await prisma.tutorArea.create({ data: { tutorId: tutor.id, areaId: area.id } });
      const subject = await createSubject();
      await prisma.tutorSubject.create({ data: { tutorId: tutor.id, subjectId: subject.id } });
      await createTutorRequirement(tutor.id, { isDefault: true, subjectIds: [subject.id] });
      return { tutor, subjectId: subject.id, headers: await getAuthHeaders(account) };
    }

    // A valid create body: online, Bangla medium, level 8, 17:30-19:00, three days.
    function packageBody(subjectId: number) {
      return {
        title: "SSC Math Booster",
        description: "Full syllabus revision with weekly tests.",
        coverage: "FULL_CURRICULUM",
        durationWeeks: 12,
        price: 15000,
        subjectIds: [subjectId],
        levelMin: 8,
        levelMax: 8,
        curricula: ["BANGLA_MEDIUM"],
        timeFrom: "17:30",
        timeTo: "19:00",
        daysPerWeek: 3,
        availableFrom: "2026-12-01",
        teachesOnline: true,
        zoneIds: [],
      };
    }

    it("a new package from a ready tutor starts as PENDING", async () => {
      const app = await createTestApp();
      const tutor = await createReadyTutor();

      const res = await app.inject({
        method: "POST",
        url: PACKAGES_URL,
        headers: tutor.headers,
        payload: packageBody(tutor.subjectId),
      });

      expect(res.statusCode).toBe(201);
      expect(JSON.parse(res.body).moderationStatus).toBe("PENDING");
      const row = await prisma.tuitionPackage.findUniqueOrThrow({
        where: { id: JSON.parse(res.body).id },
      });
      expect(row.moderationStatus).toBe("PENDING");
    });

    it("editing a REJECTED package resubmits it as PENDING and clears the note", async () => {
      const app = await createTestApp();
      const { tutor, account } = await setupTutor();
      // A resubmit passes the same profile gate as creating a package.
      await setTutorLocation(tutor.id);
      const area = await createArea();
      await prisma.tutorArea.create({ data: { tutorId: tutor.id, areaId: area.id } });
      const pkg = await createTuitionPackage(tutor.id, {
        moderationStatus: "REJECTED",
        moderationNote: "x",
      });

      const res = await app.inject({
        method: "PATCH",
        url: `${PACKAGES_URL}/${pkg.id}`,
        headers: await getAuthHeaders(account),
        payload: { title: "Revised SSC Math Booster" },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({
        moderationStatus: "PENDING",
        title: "Revised SSC Math Booster",
      });
      const row = await prisma.tuitionPackage.findUniqueOrThrow({ where: { id: pkg.id } });
      expect(row.moderationStatus).toBe("PENDING");
      expect(row.moderationNote).toBeNull();
    });

    it("editing an APPROVED package keeps it APPROVED", async () => {
      const app = await createTestApp();
      const { tutor, account } = await setupTutor();
      const pkg = await createTuitionPackage(tutor.id, { moderationStatus: "APPROVED" });

      const res = await app.inject({
        method: "PATCH",
        url: `${PACKAGES_URL}/${pkg.id}`,
        headers: await getAuthHeaders(account),
        payload: { title: "Revised SSC Math Booster" },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).moderationStatus).toBe("APPROVED");
      const row = await prisma.tuitionPackage.findUniqueOrThrow({ where: { id: pkg.id } });
      expect(row.moderationStatus).toBe("APPROVED");
    });
  });
});
