import { describe, expect, it } from "vitest";
import { prisma } from "../../lib/prisma.js";
import {
  createAccount,
  createAdmin,
  createApplication,
  createArea,
  createPlatformFee,
  createRequirement,
  createStudentProfile,
  createTestApp,
  createTuitionPackage,
  createTutorProfile,
  getAuthHeaders,
} from "../../tests/helpers.js";

const LIST_URL = "/api/v1/admin/applications";

async function people() {
  const area = await createArea();
  const student = await createStudentProfile(
    (await createAccount({ role: "STUDENT" })).id,
    area.id,
  );
  const tutor = await createTutorProfile((await createAccount({ role: "TUTOR" })).id);
  return { student, tutor };
}

async function requirementApplication(
  p: { student: { id: string }; tutor: { id: string } },
  status: "PENDING" | "CONFIRMED" = "CONFIRMED",
) {
  const requirement = await createRequirement({ studentId: p.student.id });
  return createApplication({
    requirementId: requirement.id,
    tutorId: p.tutor.id,
    studentId: p.student.id,
    initiatedBy: "TUTOR",
    status,
  });
}

// A student asked for a tutor's package.
async function packageApplication(p: { student: { id: string }; tutor: { id: string } }) {
  const pkg = await createTuitionPackage(p.tutor.id, { title: "Math Booster", price: 15000 });
  return createApplication({
    packageId: pkg.id,
    tutorId: p.tutor.id,
    studentId: p.student.id,
    initiatedBy: "STUDENT",
    status: "CONFIRMED",
  });
}

describe("admin applications", () => {
  describe("GET /api/v1/admin/applications", () => {
    it("lists requirement and package applications with their target", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const p = await people();
      const req = await requirementApplication(p);
      const pkg = await packageApplication(p);
      const requirement = await prisma.tuitionRequirement.findUniqueOrThrow({
        where: { id: req.requirementId ?? "" },
      });
      const tuitionPackage = await prisma.tuitionPackage.findUniqueOrThrow({
        where: { id: pkg.packageId ?? "" },
      });

      const res = await app.inject({
        method: "GET",
        url: LIST_URL,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.nextCursor).toBeNull();
      const byId = new Map<string, Record<string, unknown>>(
        body.applications.map((a: { id: string }) => [a.id, a]),
      );

      const reqRow = byId.get(req.id);
      expect(reqRow).toMatchObject({
        status: "CONFIRMED",
        kind: "REQUIREMENT",
        initiatedBy: "TUTOR",
        confirmedAt: expect.any(String),
        endedAt: null,
        tutor: { id: p.tutor.id, name: p.tutor.name },
        student: { id: p.student.id, name: p.student.name },
        target: {
          id: requirement.id,
          title: null,
          levelCode: requirement.levelCode,
          curriculum: requirement.curriculum,
        },
        fee: null,
      });

      const pkgRow = byId.get(pkg.id);
      expect(pkgRow).toMatchObject({
        kind: "PACKAGE",
        initiatedBy: "STUDENT",
        target: {
          id: tuitionPackage.id,
          title: "Math Booster",
          levelCode: null,
          curriculum: null,
        },
        fee: null,
      });
    });

    it("shows the latest non-VOID PLACEMENT fee, ignoring VOID and other fee types", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const p = await people();
      const withFee = await requirementApplication(p);
      const voidOnly = await requirementApplication(p);
      const otherFeeOnly = await requirementApplication(p);

      const fee = await createPlatformFee({
        tutorId: p.tutor.id,
        applicationId: withFee.id,
        feeType: "PLACEMENT",
      });
      await createPlatformFee({
        tutorId: p.tutor.id,
        applicationId: voidOnly.id,
        feeType: "PLACEMENT",
        status: "VOID",
      });
      await createPlatformFee({
        tutorId: p.tutor.id,
        applicationId: otherFeeOnly.id,
        feeType: "OTHER",
      });

      const res = await app.inject({
        method: "GET",
        url: LIST_URL,
        headers: await getAuthHeaders(admin),
      });

      const byId = new Map(
        JSON.parse(res.body).applications.map((a: { id: string; fee: unknown }) => [a.id, a]),
      ) as Map<string, { fee: unknown }>;
      expect(byId.get(withFee.id)?.fee).toEqual({
        id: fee.id,
        status: "DUE",
        amountDue: "1500.00",
        amountPaid: "0.00",
      });
      expect(byId.get(voidOnly.id)?.fee).toBeNull();
      expect(byId.get(otherFeeOnly.id)?.fee).toBeNull();
    });

    it("filters by kind, status, tutorId and studentId", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const p = await people();
      const other = await people();
      const pending = await requirementApplication(p, "PENDING");
      const confirmed = await requirementApplication(p);
      const pkg = await packageApplication(p);
      const elsewhere = await requirementApplication(other);
      const headers = await getAuthHeaders(admin);

      const kindPackage = await app.inject({
        method: "GET",
        url: `${LIST_URL}?kind=PACKAGE`,
        headers,
      });
      expect(JSON.parse(kindPackage.body).applications.map((a: { id: string }) => a.id)).toEqual([
        pkg.id,
      ]);

      const kindRequirement = await app.inject({
        method: "GET",
        url: `${LIST_URL}?kind=REQUIREMENT&tutorId=${p.tutor.id}`,
        headers,
      });
      const reqIds = JSON.parse(kindRequirement.body).applications.map((a: { id: string }) => a.id);
      expect(reqIds.sort()).toEqual([pending.id, confirmed.id].sort());

      const byStatus = await app.inject({
        method: "GET",
        url: `${LIST_URL}?status=PENDING`,
        headers,
      });
      expect(JSON.parse(byStatus.body).applications.map((a: { id: string }) => a.id)).toEqual([
        pending.id,
      ]);

      const byStudent = await app.inject({
        method: "GET",
        url: `${LIST_URL}?studentId=${other.student.id}`,
        headers,
      });
      expect(JSON.parse(byStudent.body).applications.map((a: { id: string }) => a.id)).toEqual([
        elsewhere.id,
      ]);
    });

    it("orders by appliedAt desc and paginates with nextCursor", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const p = await people();
      const first = await requirementApplication(p, "PENDING");
      const second = await requirementApplication(p, "PENDING");
      const third = await requirementApplication(p, "PENDING");
      await prisma.application.update({
        where: { id: first.id },
        data: { appliedAt: new Date("2026-05-01T00:00:00Z") },
      });
      await prisma.application.update({
        where: { id: second.id },
        data: { appliedAt: new Date("2026-05-02T00:00:00Z") },
      });
      await prisma.application.update({
        where: { id: third.id },
        data: { appliedAt: new Date("2026-05-03T00:00:00Z") },
      });
      const headers = await getAuthHeaders(admin);

      const page1 = await app.inject({ method: "GET", url: `${LIST_URL}?limit=2`, headers });
      expect(page1.statusCode).toBe(200);
      const body1 = JSON.parse(page1.body);
      expect(body1.applications.map((a: { id: string }) => a.id)).toEqual([third.id, second.id]);
      expect(body1.nextCursor).toEqual(expect.any(String));

      const page2 = await app.inject({
        method: "GET",
        url: `${LIST_URL}?limit=2&cursor=${encodeURIComponent(body1.nextCursor)}`,
        headers,
      });
      expect(page2.statusCode).toBe(200);
      const body2 = JSON.parse(page2.body);
      expect(body2.applications.map((a: { id: string }) => a.id)).toEqual([first.id]);
      expect(body2.nextCursor).toBeNull();
    });

    it("rejects an invalid cursor with 400", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });

      const res = await app.inject({
        method: "GET",
        url: `${LIST_URL}?cursor=not-a-cursor`,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe("VALIDATION_ERROR");
    });

    it("sends Cache-Control private, no-store", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });

      const res = await app.inject({
        method: "GET",
        url: LIST_URL,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe("private, no-store");
    });

    it("no token gets 401", async () => {
      const app = await createTestApp();

      const res = await app.inject({ method: "GET", url: LIST_URL });

      expect(res.statusCode).toBe(401);
    });

    it("student token gets 403", async () => {
      const app = await createTestApp();
      const student = await createAccount({ role: "STUDENT" });

      const res = await app.inject({
        method: "GET",
        url: LIST_URL,
        headers: await getAuthHeaders(student),
      });

      expect(res.statusCode).toBe(403);
    });

    it("PENDING admin gets 403", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "PENDING" });

      const res = await app.inject({
        method: "GET",
        url: LIST_URL,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(403);
    });
  });
});
