import { describe, expect, it } from "vitest";
import { prisma } from "../../lib/prisma.js";
import {
  createAccount,
  createAdmin,
  createApplication,
  createArea,
  createRequirement,
  createStudentProfile,
  createSuperAdmin,
  createTestApp,
  createTutorProfile,
  getAuthHeaders,
} from "../../tests/helpers.js";

const BASE = "/api/v1/admin/reports";

type Category = "ABUSE" | "FAKE_PROFILE" | "SPAM" | "NO_SHOW" | "OTHER";

// A student account reporting a tutor account. Names make the party mapping visible.
async function parties(names: { reporter?: string; target?: string } = {}) {
  const reporter = await createAccount({ role: "STUDENT" });
  const area = await createArea();
  const reporterProfile = await createStudentProfile(reporter.id, area.id, {
    name: names.reporter ?? "Rita Reporter",
  });
  const target = await createAccount({ role: "TUTOR" });
  const targetProfile = await createTutorProfile(target.id, {
    name: names.target ?? "Tara Target",
  });
  return { reporter, reporterProfile, area, target, targetProfile };
}

async function report(
  options: {
    status?: "OPEN" | "UNDER_REVIEW" | "RESOLVED" | "DISMISSED";
    category?: Category;
    createdAt?: Date;
    p?: Awaited<ReturnType<typeof parties>>;
    applicationId?: string;
    handledById?: string;
  } = {},
) {
  const p = options.p ?? (await parties());
  const closed = options.status === "RESOLVED" || options.status === "DISMISSED";
  const handler =
    options.handledById ?? (closed ? (await createAdmin({ status: "ACTIVE" })).id : null);
  const row = await prisma.report.create({
    data: {
      reporterId: p.reporter.id,
      targetAccountId: p.target.id,
      applicationId: options.applicationId ?? null,
      category: options.category ?? "ABUSE",
      details: "They were rude during the first lesson.",
      status: options.status ?? "OPEN",
      handledById: handler,
      resolvedAt: closed ? new Date() : null,
      resolutionNote: closed ? "Closed earlier" : null,
      createdAt: options.createdAt,
    },
  });
  return { row, ...p };
}

const idsOf = (body: string) => (JSON.parse(body).reports as { id: string }[]).map((r) => r.id);

describe("admin reports", () => {
  describe("access", () => {
    it("rejects non-admins and pending admins with 403 on every route", async () => {
      const app = await createTestApp();
      const student = await createAccount({ role: "STUDENT" });
      const pending = await createAdmin({ status: "PENDING" });
      const { row } = await report();

      for (const account of [student, pending]) {
        const headers = await getAuthHeaders(account);
        const list = await app.inject({ method: "GET", url: BASE, headers });
        const get = await app.inject({ method: "GET", url: `${BASE}/${row.id}`, headers });
        const patch = await app.inject({
          method: "PATCH",
          url: `${BASE}/${row.id}`,
          headers,
          payload: { action: "ASSIGN" },
        });
        expect([list.statusCode, get.statusCode, patch.statusCode]).toEqual([403, 403, 403]);
      }
      expect((await app.inject({ method: "GET", url: BASE })).statusCode).toBe(401);
    });
  });

  describe("GET /", () => {
    it("lists the open queue oldest first, includes UNDER_REVIEW, and pages with nextCursor", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const headers = await getAuthHeaders(admin);
      const first = await report({ createdAt: new Date("2026-06-01T00:00:00Z") });
      const second = await report({
        createdAt: new Date("2026-06-02T00:00:00Z"),
        status: "UNDER_REVIEW",
        handledById: admin.id,
      });
      const third = await report({ createdAt: new Date("2026-06-03T00:00:00Z") });
      await report({ status: "RESOLVED" });

      const page1 = await app.inject({ method: "GET", url: `${BASE}?limit=2`, headers });
      expect(idsOf(page1.body)).toEqual([first.row.id, second.row.id]);
      const cursor = JSON.parse(page1.body).nextCursor;
      expect(cursor).toEqual(expect.any(String));

      const page2 = await app.inject({
        method: "GET",
        url: `${BASE}?queue=open&limit=2&cursor=${encodeURIComponent(cursor)}`,
        headers,
      });
      expect(idsOf(page2.body)).toEqual([third.row.id]);
      expect(JSON.parse(page2.body).nextCursor).toBeNull();
    });

    it("lists the closed queue newest first and pages with nextCursor", async () => {
      const app = await createTestApp();
      const headers = await getAuthHeaders(await createAdmin({ status: "ACTIVE" }));
      const old = await report({ status: "RESOLVED", createdAt: new Date("2026-05-01T00:00:00Z") });
      const mid = await report({
        status: "DISMISSED",
        createdAt: new Date("2026-05-02T00:00:00Z"),
      });
      const recent = await report({
        status: "RESOLVED",
        createdAt: new Date("2026-05-03T00:00:00Z"),
      });
      await report();

      const page1 = await app.inject({
        method: "GET",
        url: `${BASE}?queue=closed&limit=2`,
        headers,
      });
      expect(idsOf(page1.body)).toEqual([recent.row.id, mid.row.id]);

      const page2 = await app.inject({
        method: "GET",
        url: `${BASE}?queue=closed&limit=2&cursor=${encodeURIComponent(JSON.parse(page1.body).nextCursor)}`,
        headers,
      });
      expect(idsOf(page2.body)).toEqual([old.row.id]);
    });

    it("maps both parties and the handler, and filters by category and targetAccountId", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const headers = await getAuthHeaders(admin);
      const spam = await report({ category: "SPAM" });
      await report({ category: "ABUSE" });
      const handled = await report({ status: "UNDER_REVIEW", handledById: admin.id });

      const bySpam = await app.inject({ method: "GET", url: `${BASE}?category=SPAM`, headers });
      expect(idsOf(bySpam.body)).toEqual([spam.row.id]);
      expect(JSON.parse(bySpam.body).reports[0]).toMatchObject({
        status: "OPEN",
        category: "SPAM",
        applicationId: null,
        handledBy: null,
        reporter: {
          accountId: spam.reporter.id,
          role: "STUDENT",
          status: "ACTIVE",
          name: "Rita Reporter",
          email: spam.reporter.email,
        },
        target: { accountId: spam.target.id, role: "TUTOR", name: "Tara Target" },
      });

      const byTarget = await app.inject({
        method: "GET",
        url: `${BASE}?targetAccountId=${handled.target.id}`,
        headers,
      });
      const body = JSON.parse(byTarget.body);
      expect(idsOf(byTarget.body)).toEqual([handled.row.id]);
      expect(body.reports[0].handledBy).toEqual({ accountId: admin.id, name: "Test Admin" });
    });

    it("rejects a bad queue, limit or cursor with 400", async () => {
      const app = await createTestApp();
      const headers = await getAuthHeaders(await createAdmin({ status: "ACTIVE" }));

      for (const query of ["queue=all", "limit=0", "limit=101", "cursor=nope"]) {
        const res = await app.inject({ method: "GET", url: `${BASE}?${query}`, headers });
        expect(res.statusCode).toBe(400);
      }
    });
  });

  describe("GET /:id", () => {
    it("returns the detail with the target's counts, active block and application", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const headers = await getAuthHeaders(admin);
      const p = await parties();
      const requirement = await createRequirement({
        studentId: p.reporterProfile.id,
        areaId: p.area.id,
      });
      const application = await createApplication({
        requirementId: requirement.id,
        tutorId: p.targetProfile.id,
        studentId: p.reporterProfile.id,
        initiatedBy: "TUTOR",
        status: "CONFIRMED",
      });
      const current = await report({ p, applicationId: application.id });
      // Two more reports on the same target: one open from someone else, one closed.
      await report({
        p: { ...(await parties()), target: p.target, targetProfile: p.targetProfile },
      });
      await report({
        status: "RESOLVED",
        p: { ...(await parties()), target: p.target, targetProfile: p.targetProfile },
      });
      const block = await prisma.accountBlock.create({
        data: {
          accountId: p.target.id,
          blockedById: (await createSuperAdmin()).id,
          reason: "Repeated abuse",
        },
      });

      const res = await app.inject({ method: "GET", url: `${BASE}/${current.row.id}`, headers });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toMatchObject({
        id: current.row.id,
        applicationId: application.id,
        targetOpenReports: 2,
        targetReportCount: 3,
        targetActiveBlock: { reason: "Repeated abuse", blockedAt: block.blockedAt.toISOString() },
        application: {
          id: application.id,
          status: "CONFIRMED",
          confirmedAt: application.confirmedAt?.toISOString(),
        },
        target: { status: "BLOCKED" },
      });
    });

    it("returns nulls when the target is not blocked and no application is linked", async () => {
      const app = await createTestApp();
      const headers = await getAuthHeaders(await createAdmin({ status: "ACTIVE" }));
      const { row } = await report();

      const res = await app.inject({ method: "GET", url: `${BASE}/${row.id}`, headers });

      expect(JSON.parse(res.body)).toMatchObject({
        targetOpenReports: 1,
        targetReportCount: 1,
        targetActiveBlock: null,
        application: null,
      });
    });

    it("answers 404 for an unknown report", async () => {
      const app = await createTestApp();
      const headers = await getAuthHeaders(await createAdmin({ status: "ACTIVE" }));

      const res = await app.inject({
        method: "GET",
        url: `${BASE}/0190a000-0000-7000-8000-000000000000`,
        headers,
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe("PATCH /:id", () => {
    it("ASSIGN moves OPEN to UNDER_REVIEW under the admin and audits it", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const { row } = await report();

      const res = await app.inject({
        method: "PATCH",
        url: `${BASE}/${row.id}`,
        headers: await getAuthHeaders(admin),
        payload: { action: "ASSIGN", note: "ignored" },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({
        id: row.id,
        status: "UNDER_REVIEW",
        resolvedAt: null,
        resolutionNote: null,
        handledBy: { accountId: admin.id },
        targetOpenReports: 1,
      });
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: "report.assign", entityId: row.id },
      });
      expect(audit.actorAccountId).toBe(admin.id);
      expect(audit.before).toEqual({ status: "OPEN", handledBy: null });
      expect(audit.after).toEqual({ status: "UNDER_REVIEW", handledBy: admin.id });
    });

    it("ASSIGN reassigns an UNDER_REVIEW report held by another admin, but not one held by me", async () => {
      const app = await createTestApp();
      const first = await createAdmin({ status: "ACTIVE" });
      const second = await createAdmin({ status: "ACTIVE" });
      const { row } = await report({ status: "UNDER_REVIEW", handledById: first.id });
      const send = async (account: Awaited<ReturnType<typeof createAdmin>>) =>
        app.inject({
          method: "PATCH",
          url: `${BASE}/${row.id}`,
          headers: await getAuthHeaders(account),
          payload: { action: "ASSIGN" },
        });

      const mine = await send(first);
      expect(mine.statusCode).toBe(409);
      expect(JSON.parse(mine.body).code).toBe("INVALID_CASE_STATE");

      const taken = await send(second);
      expect(taken.statusCode).toBe(200);
      expect(JSON.parse(taken.body).handledBy.accountId).toBe(second.id);
    });

    it.each([
      ["RESOLVE", "RESOLVED", "report.resolve"],
      ["DISMISS", "DISMISSED", "report.dismiss"],
    ] as const)(
      "%s closes an OPEN report with the note and audits it",
      async (action, status, audited) => {
        const app = await createTestApp();
        const admin = await createAdmin({ status: "ACTIVE" });
        const { row } = await report();

        const res = await app.inject({
          method: "PATCH",
          url: `${BASE}/${row.id}`,
          headers: await getAuthHeaders(admin),
          payload: { action, note: "  Spoke to both sides  " },
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body).toMatchObject({
          status,
          resolutionNote: "Spoke to both sides",
          handledBy: { accountId: admin.id },
          targetOpenReports: 0,
        });
        expect(body.resolvedAt).toEqual(expect.any(String));
        const audit = await prisma.auditLog.findFirstOrThrow({
          where: { action: audited, entityId: row.id },
        });
        expect(audit.after).toEqual({ status, handledBy: admin.id, note: "Spoke to both sides" });
      },
    );

    it("RESOLVE closes an UNDER_REVIEW report held by another admin and takes it over", async () => {
      const app = await createTestApp();
      const first = await createAdmin({ status: "ACTIVE" });
      const second = await createAdmin({ status: "ACTIVE" });
      const { row } = await report({ status: "UNDER_REVIEW", handledById: first.id });

      const res = await app.inject({
        method: "PATCH",
        url: `${BASE}/${row.id}`,
        headers: await getAuthHeaders(second),
        payload: { action: "RESOLVE", note: "Handled" },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).handledBy.accountId).toBe(second.id);
    });

    it("answers 409 INVALID_CASE_STATE for every action on a closed report, with no audit row", async () => {
      const app = await createTestApp();
      const headers = await getAuthHeaders(await createAdmin({ status: "ACTIVE" }));
      const resolved = await report({ status: "RESOLVED" });
      const dismissed = await report({ status: "DISMISSED" });

      for (const { row } of [resolved, dismissed]) {
        for (const payload of [
          { action: "ASSIGN" },
          { action: "RESOLVE", note: "Again" },
          { action: "DISMISS", note: "Again" },
        ]) {
          const res = await app.inject({
            method: "PATCH",
            url: `${BASE}/${row.id}`,
            headers,
            payload,
          });
          expect(res.statusCode).toBe(409);
          expect(JSON.parse(res.body).code).toBe("INVALID_CASE_STATE");
        }
      }
      expect(await prisma.auditLog.count({ where: { action: { startsWith: "report." } } })).toBe(0);
    });

    it("requires a note of 3 to 500 characters for RESOLVE and DISMISS, and rejects unknown input", async () => {
      const app = await createTestApp();
      const headers = await getAuthHeaders(await createAdmin({ status: "ACTIVE" }));
      const { row } = await report();
      const send = async (payload: object) =>
        (await app.inject({ method: "PATCH", url: `${BASE}/${row.id}`, headers, payload }))
          .statusCode;

      expect(await send({ action: "RESOLVE" })).toBe(400);
      expect(await send({ action: "DISMISS" })).toBe(400);
      expect(await send({ action: "RESOLVE", note: " ab " })).toBe(400);
      expect(await send({ action: "RESOLVE", note: "x".repeat(501) })).toBe(400);
      expect(await send({ action: "CLOSE", note: "Whatever" })).toBe(400);
      expect(await send({ action: "ASSIGN", status: "RESOLVED" })).toBe(400);
      expect((await prisma.report.findUniqueOrThrow({ where: { id: row.id } })).status).toBe(
        "OPEN",
      );
    });

    it("answers 404 for an unknown report", async () => {
      const app = await createTestApp();
      const headers = await getAuthHeaders(await createAdmin({ status: "ACTIVE" }));

      const res = await app.inject({
        method: "PATCH",
        url: `${BASE}/0190a000-0000-7000-8000-000000000000`,
        headers,
        payload: { action: "ASSIGN" },
      });

      expect(res.statusCode).toBe(404);
    });
  });
});
