import { describe, expect, it } from "vitest";
import type { Role } from "../../generated/prisma/enums.js";
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

const URL = "/api/v1/reports";
const DETAILS = "The tutor kept asking me to pay outside the app.";

async function setup() {
  const app = await createTestApp();
  const area = await createArea();
  const studentAccount = await createAccount({ role: "STUDENT" });
  const tutorAccount = await createAccount({ role: "TUTOR" });
  const student = await createStudentProfile(studentAccount.id, area.id, { name: "Sara Student" });
  const tutor = await createTutorProfile(tutorAccount.id, { name: "Tom Tutor" });
  return { app, area, studentAccount, tutorAccount, student, tutor };
}

async function applicationFor(p: { student: { id: string }; tutor: { id: string } }) {
  const requirement = await createRequirement({ studentId: p.student.id });
  return createApplication({
    requirementId: requirement.id,
    tutorId: p.tutor.id,
    studentId: p.student.id,
    initiatedBy: "TUTOR",
    status: "CONFIRMED",
  });
}

describe("POST /api/v1/reports", () => {
  it("files a report and returns it", async () => {
    const p = await setup();
    const application = await applicationFor(p);
    const res = await p.app.inject({
      method: "POST",
      url: URL,
      headers: await getAuthHeaders(p.studentAccount),
      payload: {
        targetAccountId: p.tutorAccount.id,
        category: "OFF_PLATFORM_CONTACT",
        details: `  ${DETAILS}  `,
        applicationId: application.id,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({
      category: "OFF_PLATFORM_CONTACT",
      details: DETAILS,
      status: "OPEN",
      resolvedAt: null,
      resolutionNote: null,
      applicationId: application.id,
      target: { accountId: p.tutorAccount.id, role: "TUTOR", name: "Tom Tutor" },
    });
    expect(body).not.toHaveProperty("handledBy");
    expect(body).not.toHaveProperty("handledById");
    expect(await prisma.report.count({ where: { reporterId: p.studentAccount.id } })).toBe(1);
  });

  it("lets a tutor report a student without an application", async () => {
    const p = await setup();
    const res = await p.app.inject({
      method: "POST",
      url: URL,
      headers: await getAuthHeaders(p.tutorAccount),
      payload: { targetAccountId: p.studentAccount.id, category: "ABUSE", details: DETAILS },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      applicationId: null,
      target: { role: "STUDENT", name: "Sara Student" },
    });
  });

  it("derives the target from the application when only applicationId is sent", async () => {
    const p = await setup();
    const application = await applicationFor(p);
    const asStudent = await p.app.inject({
      method: "POST",
      url: URL,
      headers: await getAuthHeaders(p.studentAccount),
      payload: { category: "NO_SHOW", details: DETAILS, applicationId: application.id },
    });
    expect(asStudent.statusCode).toBe(201);
    expect(asStudent.json().target).toMatchObject({ accountId: p.tutorAccount.id, role: "TUTOR" });

    const asTutor = await p.app.inject({
      method: "POST",
      url: URL,
      headers: await getAuthHeaders(p.tutorAccount),
      payload: { category: "NO_SHOW", details: DETAILS, applicationId: application.id },
    });
    expect(asTutor.statusCode).toBe(201);
    expect(asTutor.json().target).toMatchObject({
      accountId: p.studentAccount.id,
      role: "STUDENT",
    });
  });

  it("rejects a report with neither targetAccountId nor applicationId", async () => {
    const p = await setup();
    const res = await p.app.inject({
      method: "POST",
      url: URL,
      headers: await getAuthHeaders(p.studentAccount),
      payload: { category: "SPAM", details: DETAILS },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("Pick who you're reporting.");
  });

  it("answers 404 for an applicationId-only report by a non-party", async () => {
    const p = await setup();
    const application = await applicationFor(p);
    const outsider = await createAccount({ role: "STUDENT" });
    const res = await p.app.inject({
      method: "POST",
      url: URL,
      headers: await getAuthHeaders(outsider),
      payload: { category: "SPAM", details: DETAILS, applicationId: application.id },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toBe("Application not found");
  });

  it("returns a null name for a target without a profile", async () => {
    const p = await setup();
    const bare = await createAccount({ role: "TUTOR" });
    const res = await p.app.inject({
      method: "POST",
      url: URL,
      headers: await getAuthHeaders(p.studentAccount),
      payload: { targetAccountId: bare.id, category: "SPAM", details: DETAILS },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().target.name).toBeNull();
  });

  it("rejects reporting yourself with 400", async () => {
    const p = await setup();
    const res = await p.app.inject({
      method: "POST",
      url: URL,
      headers: await getAuthHeaders(p.studentAccount),
      payload: { targetAccountId: p.studentAccount.id, category: "SPAM", details: DETAILS },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      code: "VALIDATION_ERROR",
      message: "You can't report yourself.",
    });
  });

  it("rejects bad input with 400", async () => {
    const p = await setup();
    const headers = await getAuthHeaders(p.studentAccount);
    const base = { targetAccountId: p.tutorAccount.id, category: "SPAM", details: DETAILS };
    for (const payload of [
      { ...base, details: "too short" },
      { ...base, details: `${"x".repeat(2001)}` },
      { ...base, details: "          " },
      { ...base, category: "NOPE" },
      { ...base, targetAccountId: "not-a-uuid" },
      { ...base, applicationId: "not-a-uuid" },
    ]) {
      const res = await p.app.inject({ method: "POST", url: URL, headers, payload });
      expect(res.statusCode).toBe(400);
    }
  });

  it("answers 404 for a missing or deleted target", async () => {
    const p = await setup();
    const headers = await getAuthHeaders(p.studentAccount);
    const deleted = await createAccount({ role: "TUTOR" });
    await prisma.account.update({
      where: { id: deleted.id },
      data: { status: "DELETED", deletedAt: new Date() },
    });
    for (const targetAccountId of [crypto.randomUUID(), deleted.id]) {
      const res = await p.app.inject({
        method: "POST",
        url: URL,
        headers,
        payload: { targetAccountId, category: "SPAM", details: DETAILS },
      });
      expect(res.statusCode).toBe(404);
    }
  });

  it("refuses to report an admin with 409 REPORT_NOT_ALLOWED", async () => {
    const p = await setup();
    const admin = await createAdmin();
    const res = await p.app.inject({
      method: "POST",
      url: URL,
      headers: await getAuthHeaders(p.studentAccount),
      payload: { targetAccountId: admin.id, category: "ABUSE", details: DETAILS },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: "REPORT_NOT_ALLOWED",
      message: "This account can't be reported.",
    });
  });

  it("requires the caller and target to be the parties of the application", async () => {
    const p = await setup();
    const application = await applicationFor(p);
    const outsider = await createAccount({ role: "TUTOR" });
    const send = async (
      caller: { id: string; role: Role; email: string },
      target: string,
      applicationId: string,
    ) =>
      p.app.inject({
        method: "POST",
        url: URL,
        headers: await getAuthHeaders(caller),
        payload: { targetAccountId: target, category: "ABUSE", details: DETAILS, applicationId },
      });

    // Target is not a party.
    const a = await send(p.studentAccount, outsider.id, application.id);
    // Caller is not a party.
    const b = await send(outsider, p.studentAccount.id, application.id);
    // Application does not exist.
    const c = await send(p.studentAccount, p.tutorAccount.id, crypto.randomUUID());
    for (const res of [a, b, c]) {
      expect(res.statusCode).toBe(404);
      expect(res.json().message).toBe("Application not found");
    }
    expect(await prisma.report.count()).toBe(0);
  });

  it("refuses a second open report about the same account with 409 REPORT_EXISTS", async () => {
    const p = await setup();
    const headers = await getAuthHeaders(p.studentAccount);
    const payload = { targetAccountId: p.tutorAccount.id, category: "SPAM", details: DETAILS };
    expect((await p.app.inject({ method: "POST", url: URL, headers, payload })).statusCode).toBe(
      201,
    );

    const again = await p.app.inject({ method: "POST", url: URL, headers, payload });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({
      code: "REPORT_EXISTS",
      message: "You already have an open report about this account.",
    });

    // Still blocked while an admin is looking at it.
    await prisma.report.updateMany({ data: { status: "UNDER_REVIEW" } });
    const underReview = await p.app.inject({ method: "POST", url: URL, headers, payload });
    expect(underReview.statusCode).toBe(409);
  });

  it("maps the unique index to 409 when two requests race", async () => {
    const p = await setup();
    const headers = await getAuthHeaders(p.studentAccount);
    const payload = { targetAccountId: p.tutorAccount.id, category: "SPAM", details: DETAILS };
    const results = await Promise.all([
      p.app.inject({ method: "POST", url: URL, headers, payload }),
      p.app.inject({ method: "POST", url: URL, headers, payload }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.statusCode === 409)?.json().code).toBe("REPORT_EXISTS");
  });

  it("allows another report once the earlier one is resolved", async () => {
    const p = await setup();
    const admin = await createAdmin();
    await prisma.report.create({
      data: {
        reporterId: p.studentAccount.id,
        targetAccountId: p.tutorAccount.id,
        category: "SPAM",
        details: DETAILS,
        status: "RESOLVED",
        handledById: admin.id,
        resolvedAt: new Date(),
        resolutionNote: "Warned the tutor.",
      },
    });
    const res = await p.app.inject({
      method: "POST",
      url: URL,
      headers: await getAuthHeaders(p.studentAccount),
      payload: { targetAccountId: p.tutorAccount.id, category: "SPAM", details: DETAILS },
    });
    expect(res.statusCode).toBe(201);
  });

  it("rejects missing, admin and blocked callers", async () => {
    const p = await setup();
    const payload = { targetAccountId: p.tutorAccount.id, category: "SPAM", details: DETAILS };
    const anonymous = await p.app.inject({ method: "POST", url: URL, payload });
    expect(anonymous.statusCode).toBe(401);

    const admin = await createAdmin();
    const asAdmin = await p.app.inject({
      method: "POST",
      url: URL,
      headers: await getAuthHeaders(admin),
      payload,
    });
    expect(asAdmin.statusCode).toBe(403);

    const blocked = await createAccount({ role: "STUDENT", status: "BLOCKED" });
    const asBlocked = await p.app.inject({
      method: "POST",
      url: URL,
      headers: await getAuthHeaders(blocked),
      payload,
    });
    expect(asBlocked.statusCode).toBe(401);
  });
});

describe("GET /api/v1/reports/mine", () => {
  it("lists only my reports, newest first, hiding the note while open", async () => {
    const p = await setup();
    const admin = await createAdmin();
    const other = await createAccount({ role: "TUTOR" });
    const first = await prisma.report.create({
      data: {
        reporterId: p.studentAccount.id,
        targetAccountId: p.tutorAccount.id,
        category: "SPAM",
        details: DETAILS,
        status: "DISMISSED",
        handledById: admin.id,
        resolvedAt: new Date(),
        resolutionNote: "Not a violation.",
        createdAt: new Date(Date.now() - 60_000),
      },
    });
    const second = await prisma.report.create({
      data: {
        reporterId: p.studentAccount.id,
        targetAccountId: other.id,
        category: "ABUSE",
        details: DETAILS,
        status: "UNDER_REVIEW",
        handledById: admin.id,
        resolutionNote: "internal scratch note",
      },
    });
    // Someone else's report must not leak.
    await prisma.report.create({
      data: {
        reporterId: p.tutorAccount.id,
        targetAccountId: p.studentAccount.id,
        category: "ABUSE",
        details: DETAILS,
      },
    });

    const res = await p.app.inject({
      method: "GET",
      url: `${URL}/mine`,
      headers: await getAuthHeaders(p.studentAccount),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.nextCursor).toBeNull();
    expect(body.reports.map((r: { id: string }) => r.id)).toEqual([second.id, first.id]);
    expect(body.reports[0]).toMatchObject({ status: "UNDER_REVIEW", resolutionNote: null });
    expect(body.reports[1]).toMatchObject({
      status: "DISMISSED",
      resolutionNote: "Not a violation.",
    });
    for (const report of body.reports) {
      expect(report).not.toHaveProperty("handledBy");
      expect(report).not.toHaveProperty("handledById");
    }
  });

  it("paginates with a cursor", async () => {
    const p = await setup();
    const admin = await createAdmin();
    for (let i = 0; i < 3; i++) {
      const target = await createAccount({ role: "TUTOR" });
      await prisma.report.create({
        data: {
          reporterId: p.studentAccount.id,
          targetAccountId: target.id,
          category: "SPAM",
          details: DETAILS,
          status: "RESOLVED",
          handledById: admin.id,
          resolvedAt: new Date(),
          createdAt: new Date(Date.now() - i * 1000),
        },
      });
    }
    const headers = await getAuthHeaders(p.studentAccount);
    const page1 = (
      await p.app.inject({ method: "GET", url: `${URL}/mine?limit=2`, headers })
    ).json();
    expect(page1.reports).toHaveLength(2);
    expect(page1.nextCursor).toEqual(expect.any(String));
    const page2 = (
      await p.app.inject({
        method: "GET",
        url: `${URL}/mine?limit=2&cursor=${page1.nextCursor}`,
        headers,
      })
    ).json();
    expect(page2.reports).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
    const ids = [...page1.reports, ...page2.reports].map((r: { id: string }) => r.id);
    expect(new Set(ids).size).toBe(3);

    const bad = await p.app.inject({ method: "GET", url: `${URL}/mine?cursor=garbage`, headers });
    expect(bad.statusCode).toBe(400);
  });

  it("requires a signed-in student or tutor", async () => {
    const p = await setup();
    const anonymous = await p.app.inject({ method: "GET", url: `${URL}/mine` });
    expect(anonymous.statusCode).toBe(401);
    const admin = await createAdmin();
    const asAdmin = await p.app.inject({
      method: "GET",
      url: `${URL}/mine`,
      headers: await getAuthHeaders(admin),
    });
    expect(asAdmin.statusCode).toBe(403);
  });
});
