import { describe, expect, it } from "vitest";
import { prisma } from "../../lib/prisma.js";
import {
  createAccount,
  createAdmin,
  createApplication,
  createArea,
  createRequirement,
  createStudentProfile,
  createTestApp,
  createTutorProfile,
  getAuthHeaders,
} from "../../tests/helpers.js";

const BASE = "/api/v1/admin/disputes";

type Match = Awaited<ReturnType<typeof match>>;

// A tutor and a student with a CONFIRMED application. Disputes need one (dispute_guard trigger).
async function match() {
  const tutorAccount = await createAccount({ role: "TUTOR" });
  const tutor = await createTutorProfile(tutorAccount.id, { name: "Tara Tutor" });
  const studentAccount = await createAccount({ role: "STUDENT" });
  const area = await createArea();
  const student = await createStudentProfile(studentAccount.id, area.id, { name: "Sam Student" });
  const requirement = await createRequirement({ studentId: student.id, areaId: area.id });
  const application = await createApplication({
    requirementId: requirement.id,
    tutorId: tutor.id,
    studentId: student.id,
    initiatedBy: "TUTOR",
    status: "CONFIRMED",
  });
  return { tutorAccount, tutor, studentAccount, student, application };
}

async function dispute(
  options: {
    status?: "OPEN" | "UNDER_REVIEW" | "RESOLVED" | "DISMISSED";
    type?: "NO_SHOW" | "QUALITY" | "PAYMENT" | "SCHEDULE" | "OTHER";
    createdAt?: Date;
    m?: Match;
    raisedBy?: "student" | "tutor";
    handledById?: string;
  } = {},
) {
  const m = options.m ?? (await match());
  const byStudent = (options.raisedBy ?? "student") === "student";
  const closed = options.status === "RESOLVED" || options.status === "DISMISSED";
  const handler =
    options.handledById ?? (closed ? (await createAdmin({ status: "ACTIVE" })).id : null);
  const row = await prisma.dispute.create({
    data: {
      applicationId: m.application.id,
      raisedById: byStudent ? m.studentAccount.id : m.tutorAccount.id,
      againstId: byStudent ? m.tutorAccount.id : m.studentAccount.id,
      type: options.type ?? "NO_SHOW",
      details: "The tutor did not turn up twice.",
      status: options.status ?? "OPEN",
      handledById: handler,
      resolvedAt: closed ? new Date() : null,
      resolutionNote: closed ? "Closed earlier" : null,
      createdAt: options.createdAt,
    },
  });
  return { row, ...m };
}

const idsOf = (body: string) => (JSON.parse(body).disputes as { id: string }[]).map((r) => r.id);

describe("admin disputes", () => {
  describe("access", () => {
    it("rejects non-admins and pending admins with 403 on every route", async () => {
      const app = await createTestApp();
      const tutor = await createAccount({ role: "TUTOR" });
      const pending = await createAdmin({ status: "PENDING" });
      const { row } = await dispute();

      for (const account of [tutor, pending]) {
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
      const first = await dispute({ createdAt: new Date("2026-06-01T00:00:00Z") });
      const second = await dispute({
        createdAt: new Date("2026-06-02T00:00:00Z"),
        status: "UNDER_REVIEW",
        handledById: admin.id,
      });
      const third = await dispute({ createdAt: new Date("2026-06-03T00:00:00Z") });
      await dispute({ status: "DISMISSED" });

      const page1 = await app.inject({ method: "GET", url: `${BASE}?limit=2`, headers });
      expect(idsOf(page1.body)).toEqual([first.row.id, second.row.id]);

      const page2 = await app.inject({
        method: "GET",
        url: `${BASE}?limit=2&cursor=${encodeURIComponent(JSON.parse(page1.body).nextCursor)}`,
        headers,
      });
      expect(idsOf(page2.body)).toEqual([third.row.id]);
      expect(JSON.parse(page2.body).nextCursor).toBeNull();
    });

    it("lists the closed queue newest first and pages with nextCursor", async () => {
      const app = await createTestApp();
      const headers = await getAuthHeaders(await createAdmin({ status: "ACTIVE" }));
      const old = await dispute({
        status: "RESOLVED",
        createdAt: new Date("2026-05-01T00:00:00Z"),
      });
      const mid = await dispute({
        status: "DISMISSED",
        createdAt: new Date("2026-05-02T00:00:00Z"),
      });
      const recent = await dispute({
        status: "RESOLVED",
        createdAt: new Date("2026-05-03T00:00:00Z"),
      });
      await dispute();

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

    it("maps both parties and filters by type and applicationId", async () => {
      const app = await createTestApp();
      const headers = await getAuthHeaders(await createAdmin({ status: "ACTIVE" }));
      const payment = await dispute({ type: "PAYMENT", raisedBy: "tutor" });
      await dispute({ type: "QUALITY" });

      const byType = await app.inject({ method: "GET", url: `${BASE}?type=PAYMENT`, headers });
      expect(idsOf(byType.body)).toEqual([payment.row.id]);
      expect(JSON.parse(byType.body).disputes[0]).toMatchObject({
        applicationId: payment.application.id,
        type: "PAYMENT",
        status: "OPEN",
        handledBy: null,
        raisedBy: {
          accountId: payment.tutorAccount.id,
          role: "TUTOR",
          status: "ACTIVE",
          name: "Tara Tutor",
          email: payment.tutorAccount.email,
        },
        against: { accountId: payment.studentAccount.id, role: "STUDENT", name: "Sam Student" },
      });

      const byApplication = await app.inject({
        method: "GET",
        url: `${BASE}?applicationId=${payment.application.id}`,
        headers,
      });
      expect(idsOf(byApplication.body)).toEqual([payment.row.id]);
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
    it("returns the application and the other open disputes on it", async () => {
      const app = await createTestApp();
      const headers = await getAuthHeaders(await createAdmin({ status: "ACTIVE" }));
      const m = await match();
      const current = await dispute({ m });
      await dispute({ m, raisedBy: "tutor", status: "UNDER_REVIEW" });
      await dispute({ m, status: "RESOLVED" });
      await dispute();

      const res = await app.inject({ method: "GET", url: `${BASE}/${current.row.id}`, headers });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({
        id: current.row.id,
        otherOpenDisputes: 1,
        application: {
          id: m.application.id,
          status: "CONFIRMED",
          confirmedAt: m.application.confirmedAt?.toISOString(),
          endedAt: null,
          tutorId: m.tutor.id,
          studentId: m.student.id,
        },
      });
    });

    it("answers 404 for an unknown dispute", async () => {
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
      const { row } = await dispute();

      const res = await app.inject({
        method: "PATCH",
        url: `${BASE}/${row.id}`,
        headers: await getAuthHeaders(admin),
        payload: { action: "ASSIGN", note: "Looking into it" },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({
        status: "UNDER_REVIEW",
        resolvedAt: null,
        resolutionNote: null,
        handledBy: { accountId: admin.id },
      });
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: "dispute.assign", entityId: row.id },
      });
      expect(audit.actorAccountId).toBe(admin.id);
      expect(audit.entityType).toBe("dispute");
      expect(audit.before).toEqual({ status: "OPEN", handledBy: null });
      expect(audit.after).toEqual({
        status: "UNDER_REVIEW",
        handledBy: admin.id,
        note: "Looking into it",
      });
      const stored = await prisma.dispute.findUniqueOrThrow({ where: { id: row.id } });
      expect(stored.resolutionNote).toBeNull();
    });

    it("ASSIGN reassigns an UNDER_REVIEW dispute held by another admin, but not one held by me", async () => {
      const app = await createTestApp();
      const first = await createAdmin({ status: "ACTIVE" });
      const second = await createAdmin({ status: "ACTIVE" });
      const { row } = await dispute({ status: "UNDER_REVIEW", handledById: first.id });
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
      ["RESOLVE", "RESOLVED", "dispute.resolve"],
      ["DISMISS", "DISMISSED", "dispute.dismiss"],
    ] as const)(
      "%s closes an OPEN dispute with the note and audits it",
      async (action, status, audited) => {
        const app = await createTestApp();
        const admin = await createAdmin({ status: "ACTIVE" });
        const { row } = await dispute();

        const res = await app.inject({
          method: "PATCH",
          url: `${BASE}/${row.id}`,
          headers: await getAuthHeaders(admin),
          payload: { action, note: "  Agreed a make-up lesson  " },
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body).toMatchObject({
          status,
          resolutionNote: "Agreed a make-up lesson",
          handledBy: { accountId: admin.id },
          otherOpenDisputes: 0,
        });
        expect(body.resolvedAt).toEqual(expect.any(String));
        const audit = await prisma.auditLog.findFirstOrThrow({
          where: { action: audited, entityId: row.id },
        });
        expect(audit.after).toEqual({
          status,
          handledBy: admin.id,
          note: "Agreed a make-up lesson",
        });
      },
    );

    it("RESOLVE closes an UNDER_REVIEW dispute held by another admin and takes it over", async () => {
      const app = await createTestApp();
      const first = await createAdmin({ status: "ACTIVE" });
      const second = await createAdmin({ status: "ACTIVE" });
      const { row } = await dispute({ status: "UNDER_REVIEW", handledById: first.id });

      const res = await app.inject({
        method: "PATCH",
        url: `${BASE}/${row.id}`,
        headers: await getAuthHeaders(second),
        payload: { action: "RESOLVE", note: "Handled" },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).handledBy.accountId).toBe(second.id);
    });

    it("answers 409 INVALID_CASE_STATE for every action on a closed dispute, with no audit row", async () => {
      const app = await createTestApp();
      const headers = await getAuthHeaders(await createAdmin({ status: "ACTIVE" }));
      const resolved = await dispute({ status: "RESOLVED" });
      const dismissed = await dispute({ status: "DISMISSED" });

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
      expect(await prisma.auditLog.count({ where: { action: { startsWith: "dispute." } } })).toBe(
        0,
      );
    });

    it("requires a note of 3 to 500 characters for RESOLVE and DISMISS, and rejects unknown input", async () => {
      const app = await createTestApp();
      const headers = await getAuthHeaders(await createAdmin({ status: "ACTIVE" }));
      const { row } = await dispute();
      const send = async (payload: object) =>
        (await app.inject({ method: "PATCH", url: `${BASE}/${row.id}`, headers, payload }))
          .statusCode;

      expect(await send({ action: "RESOLVE" })).toBe(400);
      expect(await send({ action: "DISMISS" })).toBe(400);
      expect(await send({ action: "DISMISS", note: " ab " })).toBe(400);
      expect(await send({ action: "RESOLVE", note: "x".repeat(501) })).toBe(400);
      expect(await send({ action: "CLOSE", note: "Whatever" })).toBe(400);
      expect(await send({ action: "ASSIGN", status: "RESOLVED" })).toBe(400);
      expect((await prisma.dispute.findUniqueOrThrow({ where: { id: row.id } })).status).toBe(
        "OPEN",
      );
    });

    it("answers 404 for an unknown dispute", async () => {
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
