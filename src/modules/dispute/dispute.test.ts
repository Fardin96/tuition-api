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

const URL = "/api/v1/disputes";
const DETAILS = "The tutor did not turn up for the last two sessions.";

async function setup(status: "PENDING" | "CONFIRMED" | "COMPLETED" | "CANCELLED" = "CONFIRMED") {
  const app = await createTestApp();
  const area = await createArea();
  const studentAccount = await createAccount({ role: "STUDENT" });
  const tutorAccount = await createAccount({ role: "TUTOR" });
  const student = await createStudentProfile(studentAccount.id, area.id, { name: "Sara Student" });
  const tutor = await createTutorProfile(tutorAccount.id, { name: "Tom Tutor" });
  const requirement = await createRequirement({ studentId: student.id });
  const application = await createApplication({
    requirementId: requirement.id,
    tutorId: tutor.id,
    studentId: student.id,
    initiatedBy: "TUTOR",
    status,
  });
  return { app, area, studentAccount, tutorAccount, student, tutor, application };
}

describe("POST /api/v1/disputes", () => {
  it("lets the student dispute a confirmed tuition; the other party is derived", async () => {
    const p = await setup();
    const res = await p.app.inject({
      method: "POST",
      url: URL,
      headers: await getAuthHeaders(p.studentAccount),
      payload: { applicationId: p.application.id, type: "NO_SHOW", details: `  ${DETAILS} ` },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({
      applicationId: p.application.id,
      type: "NO_SHOW",
      details: DETAILS,
      status: "OPEN",
      resolvedAt: null,
      resolutionNote: null,
      against: { accountId: p.tutorAccount.id, role: "TUTOR", name: "Tom Tutor" },
    });
    expect(body).not.toHaveProperty("handledBy");
    const row = await prisma.dispute.findUniqueOrThrow({ where: { id: body.id } });
    expect(row.raisedById).toBe(p.studentAccount.id);
    expect(row.againstId).toBe(p.tutorAccount.id);
  });

  it("lets the tutor dispute a completed tuition", async () => {
    const p = await setup("COMPLETED");
    const res = await p.app.inject({
      method: "POST",
      url: URL,
      headers: await getAuthHeaders(p.tutorAccount),
      payload: { applicationId: p.application.id, type: "PAYMENT", details: DETAILS },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().against).toMatchObject({
      accountId: p.studentAccount.id,
      role: "STUDENT",
      name: "Sara Student",
    });
  });

  it("answers 404 for a non-party and for a missing application", async () => {
    const p = await setup();
    const outsider = await createAccount({ role: "TUTOR" });
    const asOutsider = await p.app.inject({
      method: "POST",
      url: URL,
      headers: await getAuthHeaders(outsider),
      payload: { applicationId: p.application.id, type: "OTHER", details: DETAILS },
    });
    expect(asOutsider.statusCode).toBe(404);
    expect(asOutsider.json().message).toBe("Application not found");

    const missing = await p.app.inject({
      method: "POST",
      url: URL,
      headers: await getAuthHeaders(p.studentAccount),
      payload: { applicationId: crypto.randomUUID(), type: "OTHER", details: DETAILS },
    });
    expect(missing.statusCode).toBe(404);
    expect(await prisma.dispute.count()).toBe(0);
  });

  it("refuses other statuses with 409 DISPUTE_NOT_ALLOWED", async () => {
    for (const status of ["PENDING", "CANCELLED"] as const) {
      const p = await setup(status);
      const res = await p.app.inject({
        method: "POST",
        url: URL,
        headers: await getAuthHeaders(p.studentAccount),
        payload: { applicationId: p.application.id, type: "QUALITY", details: DETAILS },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        code: "DISPUTE_NOT_ALLOWED",
        message: "Only a confirmed or completed tuition can be disputed.",
      });
    }
  });

  it("refuses a second open dispute by the same caller, but not by the other party", async () => {
    const p = await setup();
    const studentHeaders = await getAuthHeaders(p.studentAccount);
    const payload = { applicationId: p.application.id, type: "QUALITY", details: DETAILS };
    expect(
      (await p.app.inject({ method: "POST", url: URL, headers: studentHeaders, payload }))
        .statusCode,
    ).toBe(201);

    const again = await p.app.inject({
      method: "POST",
      url: URL,
      headers: studentHeaders,
      payload,
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe("DISPUTE_EXISTS");

    await prisma.dispute.updateMany({ data: { status: "UNDER_REVIEW" } });
    const underReview = await p.app.inject({
      method: "POST",
      url: URL,
      headers: studentHeaders,
      payload,
    });
    expect(underReview.statusCode).toBe(409);

    const counter = await p.app.inject({
      method: "POST",
      url: URL,
      headers: await getAuthHeaders(p.tutorAccount),
      payload,
    });
    expect(counter.statusCode).toBe(201);
  });

  it("maps the unique index to 409 when two requests race", async () => {
    const p = await setup();
    const headers = await getAuthHeaders(p.studentAccount);
    const payload = { applicationId: p.application.id, type: "QUALITY", details: DETAILS };
    const results = await Promise.all([
      p.app.inject({ method: "POST", url: URL, headers, payload }),
      p.app.inject({ method: "POST", url: URL, headers, payload }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.statusCode === 409)?.json().code).toBe("DISPUTE_EXISTS");
  });

  it("allows a new dispute once the earlier one is resolved", async () => {
    const p = await setup();
    const admin = await createAdmin();
    await prisma.dispute.create({
      data: {
        applicationId: p.application.id,
        raisedById: p.studentAccount.id,
        againstId: p.tutorAccount.id,
        type: "QUALITY",
        details: DETAILS,
        status: "RESOLVED",
        handledById: admin.id,
        resolvedAt: new Date(),
        resolutionNote: "Sorted out.",
      },
    });
    const res = await p.app.inject({
      method: "POST",
      url: URL,
      headers: await getAuthHeaders(p.studentAccount),
      payload: { applicationId: p.application.id, type: "QUALITY", details: DETAILS },
    });
    expect(res.statusCode).toBe(201);
  });

  it("rejects bad input with 400", async () => {
    const p = await setup();
    const headers = await getAuthHeaders(p.studentAccount);
    const base = { applicationId: p.application.id, type: "OTHER", details: DETAILS };
    for (const payload of [
      { ...base, details: "short" },
      { ...base, details: "x".repeat(2001) },
      { ...base, type: "NOPE" },
      { ...base, applicationId: "nope" },
      { type: "OTHER", details: DETAILS },
    ]) {
      const res = await p.app.inject({ method: "POST", url: URL, headers, payload });
      expect(res.statusCode).toBe(400);
    }
  });

  it("rejects missing, admin and blocked callers", async () => {
    const p = await setup();
    const payload = { applicationId: p.application.id, type: "OTHER", details: DETAILS };
    expect((await p.app.inject({ method: "POST", url: URL, payload })).statusCode).toBe(401);
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

describe("GET /api/v1/disputes/mine", () => {
  it("lists only disputes I raised, newest first, with the note only when closed", async () => {
    const p = await setup();
    const admin = await createAdmin();
    const closed = await prisma.dispute.create({
      data: {
        applicationId: p.application.id,
        raisedById: p.studentAccount.id,
        againstId: p.tutorAccount.id,
        type: "NO_SHOW",
        details: DETAILS,
        status: "RESOLVED",
        handledById: admin.id,
        resolvedAt: new Date(),
        resolutionNote: "Tutor warned.",
        createdAt: new Date(Date.now() - 60_000),
      },
    });
    const open = await prisma.dispute.create({
      data: {
        applicationId: p.application.id,
        raisedById: p.studentAccount.id,
        againstId: p.tutorAccount.id,
        type: "QUALITY",
        details: DETAILS,
        status: "UNDER_REVIEW",
        handledById: admin.id,
        resolutionNote: "internal scratch note",
      },
    });
    // The tutor's own dispute on the same tuition is private to the tutor.
    await prisma.dispute.create({
      data: {
        applicationId: p.application.id,
        raisedById: p.tutorAccount.id,
        againstId: p.studentAccount.id,
        type: "PAYMENT",
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
    expect(body.disputes.map((d: { id: string }) => d.id)).toEqual([open.id, closed.id]);
    expect(body.disputes[0].resolutionNote).toBeNull();
    expect(body.disputes[1].resolutionNote).toBe("Tutor warned.");
    expect(body.nextCursor).toBeNull();
    for (const dispute of body.disputes) {
      expect(dispute).not.toHaveProperty("handledBy");
      expect(dispute.against.accountId).toBe(p.tutorAccount.id);
    }
  });

  it("filters by applicationId and 404s for a non-party", async () => {
    const p = await setup();
    const otherRequirement = await createRequirement({ studentId: p.student.id });
    const otherApplication = await createApplication({
      requirementId: otherRequirement.id,
      tutorId: p.tutor.id,
      studentId: p.student.id,
      initiatedBy: "TUTOR",
      status: "CONFIRMED",
    });
    for (const application of [p.application, otherApplication]) {
      await prisma.dispute.create({
        data: {
          applicationId: application.id,
          raisedById: p.studentAccount.id,
          againstId: p.tutorAccount.id,
          type: "OTHER",
          details: DETAILS,
        },
      });
    }
    const headers = await getAuthHeaders(p.studentAccount);
    const filtered = await p.app.inject({
      method: "GET",
      url: `${URL}/mine?applicationId=${otherApplication.id}`,
      headers,
    });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json().disputes).toHaveLength(1);
    expect(filtered.json().disputes[0].applicationId).toBe(otherApplication.id);

    const outsider = await createAccount({ role: "STUDENT" });
    const hidden = await p.app.inject({
      method: "GET",
      url: `${URL}/mine?applicationId=${p.application.id}`,
      headers: await getAuthHeaders(outsider),
    });
    expect(hidden.statusCode).toBe(404);

    const none = await p.app.inject({
      method: "GET",
      url: `${URL}/mine`,
      headers: await getAuthHeaders(outsider),
    });
    expect(none.json().disputes).toEqual([]);
  });

  it("paginates with a cursor", async () => {
    const p = await setup();
    const admin = await createAdmin();
    for (let i = 0; i < 3; i++) {
      await prisma.dispute.create({
        data: {
          applicationId: p.application.id,
          raisedById: p.studentAccount.id,
          againstId: p.tutorAccount.id,
          type: "OTHER",
          details: DETAILS,
          status: "DISMISSED",
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
    expect(page1.disputes).toHaveLength(2);
    expect(page1.nextCursor).toEqual(expect.any(String));
    const page2 = (
      await p.app.inject({
        method: "GET",
        url: `${URL}/mine?limit=2&cursor=${page1.nextCursor}`,
        headers,
      })
    ).json();
    expect(page2.disputes).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
    const ids = [...page1.disputes, ...page2.disputes].map((d: { id: string }) => d.id);
    expect(new Set(ids).size).toBe(3);
  });

  it("requires a signed-in student or tutor", async () => {
    const p = await setup();
    expect((await p.app.inject({ method: "GET", url: `${URL}/mine` })).statusCode).toBe(401);
    const admin = await createAdmin();
    const asAdmin = await p.app.inject({
      method: "GET",
      url: `${URL}/mine`,
      headers: await getAuthHeaders(admin),
    });
    expect(asAdmin.statusCode).toBe(403);
  });
});
