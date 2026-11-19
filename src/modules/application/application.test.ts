import { describe, expect, it } from "vitest";
import { prisma } from "../../lib/prisma.js";
import {
  createAccount,
  createApplication,
  createArea,
  createRequirement,
  createStudentProfile,
  createSubject,
  createTestApp,
  createTuitionPackage,
  createTutorProfile,
  createTutorRequirement,
  getAuthHeaders,
  setTutorLocation,
} from "../../tests/helpers.js";

const BASE = "/api/v1";

type Actor = {
  account: { id: string; role: "TUTOR" | "STUDENT" };
  headers: Record<string, string>;
};

// A tutor that passes the apply gate: name, address, pin, area, phone, default requirement set.
async function createReadyTutor({ defaultSet = true }: { defaultSet?: boolean } = {}) {
  const account = await createAccount({ role: "TUTOR" });
  const tutor = await createTutorProfile(account.id);
  await setTutorLocation(tutor.id);
  const area = await createArea();
  await prisma.tutorArea.create({ data: { tutorId: tutor.id, areaId: area.id } });
  if (defaultSet) {
    const subject = await createSubject();
    await prisma.tutorSubject.create({ data: { tutorId: tutor.id, subjectId: subject.id } });
    await createTutorRequirement(tutor.id, { isDefault: true, subjectIds: [subject.id] });
  }
  return { tutor, actor: { account, headers: await getAuthHeaders(account) } as Actor };
}

// A tutor with a profile but none of the apply prerequisites. Used by plain fixtures.
async function createPlainTutor() {
  const account = await createAccount({ role: "TUTOR" });
  const tutor = await createTutorProfile(account.id);
  return { tutor, actor: { account, headers: await getAuthHeaders(account) } as Actor };
}

async function createStudent() {
  const account = await createAccount({ role: "STUDENT" });
  const area = await createArea();
  const student = await createStudentProfile(account.id, area.id);
  return { student, actor: { account, headers: await getAuthHeaders(account) } as Actor };
}

async function setCommission(percent: number) {
  await prisma.platformSetting.create({ data: { key: "commission_percent", value: percent } });
}

function dhakaDatePlus(days: number): string {
  const d = new Date(Date.now() + 6 * 60 * 60 * 1000);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function notificationsFor(applicationId: string) {
  return prisma.notificationLog.findMany({
    where: { applicationId },
    orderBy: { createdAt: "asc" },
  });
}

async function statusOf(applicationId: string) {
  return prisma.application.findUniqueOrThrow({ where: { id: applicationId } });
}

describe("POST /requirements/:id/applications (apply, #57)", () => {
  it("creates a PENDING application and queues one APPLICATION_RECEIVED to the student", async () => {
    const app = await createTestApp();
    const { student } = await createStudent();
    const requirement = await createRequirement({ studentId: student.id });
    const { tutor, actor } = await createReadyTutor();

    const res = await app.inject({
      method: "POST",
      url: `${BASE}/requirements/${requirement.id}/applications`,
      headers: actor.headers,
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({
      initiatedBy: "TUTOR",
      status: "PENDING",
      confirmedAt: null,
      endedAt: null,
      counterpartContact: null,
      fee: null,
      allowedActions: ["withdraw"],
      tutor: { id: tutor.id },
      student: { id: student.id },
      target: {
        kind: "REQUIREMENT",
        id: requirement.id,
        status: "OPEN",
        closed: false,
        title: null,
        price: null,
        durationWeeks: null,
      },
    });

    const rows = await notificationsFor(body.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventType: "APPLICATION_RECEIVED",
      recipientId: student.accountId,
      templateName: "application_received",
      status: "PENDING",
    });
  });

  it("returns 409 ALREADY_APPLIED with the existing application id on a second apply", async () => {
    const app = await createTestApp();
    const { student } = await createStudent();
    const requirement = await createRequirement({ studentId: student.id });
    const { actor } = await createReadyTutor();

    const first = await app.inject({
      method: "POST",
      url: `${BASE}/requirements/${requirement.id}/applications`,
      headers: actor.headers,
    });
    expect(first.statusCode).toBe(201);
    const firstId = JSON.parse(first.body).id;

    const second = await app.inject({
      method: "POST",
      url: `${BASE}/requirements/${requirement.id}/applications`,
      headers: actor.headers,
    });

    expect(second.statusCode).toBe(409);
    const error = JSON.parse(second.body);
    expect(error.code).toBe("ALREADY_APPLIED");
    expect(error.details).toEqual({ applicationId: firstId });
    expect(await prisma.application.count({ where: { requirementId: requirement.id } })).toBe(1);
  });

  it("returns 403 PROFILE_INCOMPLETE with details.missing when the tutor has no default requirement set", async () => {
    const app = await createTestApp();
    const { student } = await createStudent();
    const requirement = await createRequirement({ studentId: student.id });
    const { tutor, actor } = await createReadyTutor({ defaultSet: false });
    // A non-default set does not satisfy the gate.
    await createTutorRequirement(tutor.id, { name: "Not default" });

    const res = await app.inject({
      method: "POST",
      url: `${BASE}/requirements/${requirement.id}/applications`,
      headers: actor.headers,
    });

    expect(res.statusCode).toBe(403);
    const error = JSON.parse(res.body);
    expect(error.code).toBe("PROFILE_INCOMPLETE");
    expect(error.details).toEqual({ missing: ["default_requirement"] });
    expect(await prisma.application.count({ where: { tutorId: tutor.id } })).toBe(0);
  });

  it("lists every missing piece when the tutor has no pin and no area", async () => {
    const app = await createTestApp();
    const { student } = await createStudent();
    const requirement = await createRequirement({ studentId: student.id });
    const { actor } = await createPlainTutor();

    const res = await app.inject({
      method: "POST",
      url: `${BASE}/requirements/${requirement.id}/applications`,
      headers: actor.headers,
    });

    expect(res.statusCode).toBe(403);
    const { details } = JSON.parse(res.body);
    expect(details.missing).toEqual(
      expect.arrayContaining(["location_pin", "area", "default_requirement"]),
    );
  });

  it("returns 409 LISTING_NOT_OPEN for a CLOSED requirement", async () => {
    const app = await createTestApp();
    const { student } = await createStudent();
    const requirement = await createRequirement({ studentId: student.id, status: "CLOSED" });
    const { actor } = await createReadyTutor();

    const res = await app.inject({
      method: "POST",
      url: `${BASE}/requirements/${requirement.id}/applications`,
      headers: actor.headers,
    });

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("LISTING_NOT_OPEN");
    expect(await prisma.application.count({ where: { requirementId: requirement.id } })).toBe(0);
  });

  it("returns 404 for a DRAFT requirement", async () => {
    const app = await createTestApp();
    const { student } = await createStudent();
    const requirement = await createRequirement({ studentId: student.id, status: "DRAFT" });
    const { actor } = await createReadyTutor();

    const res = await app.inject({
      method: "POST",
      url: `${BASE}/requirements/${requirement.id}/applications`,
      headers: actor.headers,
    });

    expect(res.statusCode).toBe(404);
  });

  it("returns 409 APPLICATION_CLOSED when the requirement already has a CONFIRMED application", async () => {
    const app = await createTestApp();
    const { student } = await createStudent();
    const requirement = await createRequirement({ studentId: student.id });
    const { tutor: winner } = await createPlainTutor();
    await createApplication({
      requirementId: requirement.id,
      tutorId: winner.id,
      studentId: student.id,
      initiatedBy: "TUTOR",
      status: "CONFIRMED",
    });
    const { actor } = await createReadyTutor();

    const res = await app.inject({
      method: "POST",
      url: `${BASE}/requirements/${requirement.id}/applications`,
      headers: actor.headers,
    });

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("APPLICATION_CLOSED");
  });

  it("returns 403 when a student calls it", async () => {
    const app = await createTestApp();
    const { student, actor } = await createStudent();
    const requirement = await createRequirement({ studentId: student.id });

    const res = await app.inject({
      method: "POST",
      url: `${BASE}/requirements/${requirement.id}/applications`,
      headers: actor.headers,
    });

    expect(res.statusCode).toBe(403);
  });
});

describe("POST /packages/:id/applications (request package, #58)", () => {
  async function setupPackage(overrides: { moderationStatus?: "PENDING" | "REJECTED" } = {}) {
    const { tutor } = await createPlainTutor();
    await prisma.tutor.update({ where: { id: tutor.id }, data: { isListed: true } });
    const pkg = await createTuitionPackage(tutor.id);
    if (overrides.moderationStatus) {
      await prisma.tuitionPackage.update({
        where: { id: pkg.id },
        data: { moderationStatus: overrides.moderationStatus },
      });
    }
    return { tutor, pkg };
  }

  it("creates a STUDENT-initiated application and queues APPLICATION_RECEIVED to the tutor", async () => {
    const app = await createTestApp();
    const { tutor, pkg } = await setupPackage();
    const { student, actor } = await createStudent();

    const res = await app.inject({
      method: "POST",
      url: `${BASE}/packages/${pkg.id}/applications`,
      headers: actor.headers,
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({
      initiatedBy: "STUDENT",
      status: "PENDING",
      allowedActions: ["withdraw"],
      student: { id: student.id },
      tutor: { id: tutor.id },
      target: {
        kind: "PACKAGE",
        id: pkg.id,
        closed: false,
        title: pkg.title,
        price: pkg.price,
        durationWeeks: pkg.durationWeeks,
        salary: null,
        areaId: null,
        curriculum: null,
        levelCode: null,
        academicGroup: null,
      },
    });

    const rows = await notificationsFor(body.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventType: "APPLICATION_RECEIVED",
      recipientId: tutor.accountId,
      templateName: "application_received",
    });
  });

  it("returns 404 for a package that is not APPROVED", async () => {
    const app = await createTestApp();
    const { pkg } = await setupPackage({ moderationStatus: "PENDING" });
    const { actor } = await createStudent();

    const res = await app.inject({
      method: "POST",
      url: `${BASE}/packages/${pkg.id}/applications`,
      headers: actor.headers,
    });

    expect(res.statusCode).toBe(404);
    expect(await prisma.application.count({ where: { packageId: pkg.id } })).toBe(0);
  });

  it("returns 404 when the tutor is not listed", async () => {
    const app = await createTestApp();
    const { tutor } = await createPlainTutor();
    const pkg = await createTuitionPackage(tutor.id);
    const { actor } = await createStudent();

    const res = await app.inject({
      method: "POST",
      url: `${BASE}/packages/${pkg.id}/applications`,
      headers: actor.headers,
    });

    expect(res.statusCode).toBe(404);
  });

  it("returns 409 ALREADY_APPLIED on a repeat request", async () => {
    const app = await createTestApp();
    const { pkg } = await setupPackage();
    const { actor } = await createStudent();

    const first = await app.inject({
      method: "POST",
      url: `${BASE}/packages/${pkg.id}/applications`,
      headers: actor.headers,
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "POST",
      url: `${BASE}/packages/${pkg.id}/applications`,
      headers: actor.headers,
    });
    expect(second.statusCode).toBe(409);
    expect(JSON.parse(second.body).code).toBe("ALREADY_APPLIED");
  });
});

describe("confirm (#63)", () => {
  async function setupCompetingApplications() {
    const { student, actor: studentActor } = await createStudent();
    const requirement = await createRequirement({ studentId: student.id, salary: 5000 });
    const { tutor: tutorA, actor: tutorAActor } = await createPlainTutor();
    const { tutor: tutorB } = await createPlainTutor();
    const appA = await createApplication({
      requirementId: requirement.id,
      tutorId: tutorA.id,
      studentId: student.id,
      initiatedBy: "TUTOR",
    });
    const appB = await createApplication({
      requirementId: requirement.id,
      tutorId: tutorB.id,
      studentId: student.id,
      initiatedBy: "TUTOR",
    });
    return { requirement, student, studentActor, tutorA, tutorAActor, tutorB, appA, appB };
  }

  it("confirms by the counterparty, rejects the other pending applications, and sets confirmedAt", async () => {
    const app = await createTestApp();
    const { appA, appB, studentActor } = await setupCompetingApplications();

    const res = await app.inject({
      method: "POST",
      url: `${BASE}/applications/${appA.id}/confirm`,
      headers: studentActor.headers,
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      id: appA.id,
      status: "CONFIRMED",
      allowedActions: ["cancel", "complete"],
    });
    const confirmed = await statusOf(appA.id);
    expect(confirmed.status).toBe("CONFIRMED");
    expect(confirmed.confirmedAt).toBeInstanceOf(Date);
    expect((await statusOf(appB.id)).status).toBe("REJECTED");
  });

  it("creates a DUE placement fee of salary x commission, due 7 days out, when commission is set", async () => {
    const app = await createTestApp();
    await setCommission(10);
    const { appA, studentActor } = await setupCompetingApplications();

    const res = await app.inject({
      method: "POST",
      url: `${BASE}/applications/${appA.id}/confirm`,
      headers: studentActor.headers,
    });
    expect(res.statusCode).toBe(200);

    const fees = await prisma.platformFee.findMany({ where: { applicationId: appA.id } });
    expect(fees).toHaveLength(1);
    expect(fees[0]).toMatchObject({ feeType: "PLACEMENT", status: "DUE" });
    expect(Number(fees[0].amountDue)).toBe(500);
    expect(Number(fees[0].amountPaid)).toBe(0);
    expect(fees[0].dueDate.toISOString().slice(0, 10)).toBe(dhakaDatePlus(7));
  });

  it("a package's placement fee is commission x the TOTAL package price", async () => {
    const app = await createTestApp();
    await setCommission(10);
    const { tutor, actor: tutorActor } = await createPlainTutor();
    await prisma.tutor.update({ where: { id: tutor.id }, data: { isListed: true } });
    const pkg = await createTuitionPackage(tutor.id, { price: 15000 });
    const { student } = await createStudent();
    const application = await createApplication({
      packageId: pkg.id,
      tutorId: tutor.id,
      studentId: student.id,
      initiatedBy: "STUDENT",
    });

    // A student-initiated application is confirmed by the tutor.
    const res = await app.inject({
      method: "POST",
      url: `${BASE}/applications/${application.id}/confirm`,
      headers: tutorActor.headers,
    });
    expect(res.statusCode).toBe(200);

    const fees = await prisma.platformFee.findMany({ where: { applicationId: application.id } });
    expect(fees).toHaveLength(1);
    expect(fees[0]).toMatchObject({ feeType: "PLACEMENT", status: "DUE" });
    expect(Number(fees[0].amountDue)).toBe(1500);
  });

  it("creates a 40% placement fee when the commission setting is absent", async () => {
    const app = await createTestApp();
    const { appA, studentActor } = await setupCompetingApplications();

    const res = await app.inject({
      method: "POST",
      url: `${BASE}/applications/${appA.id}/confirm`,
      headers: studentActor.headers,
    });

    expect(res.statusCode).toBe(200);
    const fees = await prisma.platformFee.findMany({ where: { applicationId: appA.id } });
    expect(fees).toHaveLength(1);
    expect(fees[0]).toMatchObject({ feeType: "PLACEMENT", status: "DUE" });
    // salary 5000 x 40%, rounded to 2 decimals.
    expect(Number(fees[0].amountDue)).toBe(Number((5000 * 0.4).toFixed(2)));
  });

  it("creates no fee when commission_percent is explicitly 0", async () => {
    const app = await createTestApp();
    await setCommission(0);
    const { appA, studentActor } = await setupCompetingApplications();

    const res = await app.inject({
      method: "POST",
      url: `${BASE}/applications/${appA.id}/confirm`,
      headers: studentActor.headers,
    });

    expect(res.statusCode).toBe(200);
    expect(await prisma.platformFee.count({ where: { applicationId: appA.id } })).toBe(0);
  });

  it("queues APPLICATION_CONFIRMED to the initiator", async () => {
    const app = await createTestApp();
    const { appA, tutorA, studentActor } = await setupCompetingApplications();

    await app.inject({
      method: "POST",
      url: `${BASE}/applications/${appA.id}/confirm`,
      headers: studentActor.headers,
    });

    const rows = await notificationsFor(appA.id);
    const confirmed = rows.filter((r) => r.eventType === "APPLICATION_CONFIRMED");
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]).toMatchObject({
      recipientId: tutorA.accountId,
      templateName: "application_confirmed",
      dedupeKey: `application_confirmed:${appA.id}`,
    });
  });

  it("returns 409 INVALID_APPLICATION_STATE when the initiator tries to confirm", async () => {
    const app = await createTestApp();
    const { appA, tutorAActor } = await setupCompetingApplications();

    const res = await app.inject({
      method: "POST",
      url: `${BASE}/applications/${appA.id}/confirm`,
      headers: tutorAActor.headers,
    });

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("INVALID_APPLICATION_STATE");
    expect((await statusOf(appA.id)).status).toBe("PENDING");
  });

  it("returns 404 for a user who is not a party to the application", async () => {
    const app = await createTestApp();
    const { appA } = await setupCompetingApplications();
    const { actor: outsider } = await createPlainTutor();

    const res = await app.inject({
      method: "POST",
      url: `${BASE}/applications/${appA.id}/confirm`,
      headers: outsider.headers,
    });

    expect(res.statusCode).toBe(404);
    expect((await statusOf(appA.id)).status).toBe("PENDING");
  });
});

describe("reject, withdraw and reopen", () => {
  it("reject by the counterparty sets REJECTED", async () => {
    const app = await createTestApp();
    const { student, actor: studentActor } = await createStudent();
    const requirement = await createRequirement({ studentId: student.id });
    const { tutor, actor: tutorActor } = await createPlainTutor();
    const application = await createApplication({
      requirementId: requirement.id,
      tutorId: tutor.id,
      studentId: student.id,
      initiatedBy: "TUTOR",
    });

    const res = await app.inject({
      method: "POST",
      url: `${BASE}/applications/${application.id}/reject`,
      headers: studentActor.headers,
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe("REJECTED");
    expect((await statusOf(application.id)).status).toBe("REJECTED");
    // The initiator cannot reject its own application.
    const own = await app.inject({
      method: "POST",
      url: `${BASE}/applications/${application.id}/reject`,
      headers: tutorActor.headers,
    });
    expect(own.statusCode).toBe(409);
  });

  it("withdraw by the initiator sets WITHDRAWN", async () => {
    const app = await createTestApp();
    const { student } = await createStudent();
    const requirement = await createRequirement({ studentId: student.id });
    const { tutor, actor: tutorActor } = await createPlainTutor();
    const application = await createApplication({
      requirementId: requirement.id,
      tutorId: tutor.id,
      studentId: student.id,
      initiatedBy: "TUTOR",
    });

    const res = await app.inject({
      method: "POST",
      url: `${BASE}/applications/${application.id}/withdraw`,
      headers: tutorActor.headers,
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ status: "WITHDRAWN", allowedActions: ["reopen"] });
    expect((await statusOf(application.id)).status).toBe("WITHDRAWN");
  });

  it("reopen by the initiator sets PENDING with a new appliedAt and a second APPLICATION_RECEIVED", async () => {
    const app = await createTestApp();
    const { student } = await createStudent();
    const requirement = await createRequirement({ studentId: student.id });
    const { actor: tutorActor } = await createReadyTutor();

    const applied = await app.inject({
      method: "POST",
      url: `${BASE}/requirements/${requirement.id}/applications`,
      headers: tutorActor.headers,
    });
    const applicationId = JSON.parse(applied.body).id;
    await app.inject({
      method: "POST",
      url: `${BASE}/applications/${applicationId}/withdraw`,
      headers: tutorActor.headers,
    });
    const before = await statusOf(applicationId);

    const res = await app.inject({
      method: "POST",
      url: `${BASE}/applications/${applicationId}/reopen`,
      headers: tutorActor.headers,
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ status: "PENDING", allowedActions: ["withdraw"] });
    const after = await statusOf(applicationId);
    expect(after.status).toBe("PENDING");
    expect(after.appliedAt.getTime()).toBeGreaterThan(before.appliedAt.getTime());

    const received = (await notificationsFor(applicationId)).filter(
      (r) => r.eventType === "APPLICATION_RECEIVED",
    );
    expect(received).toHaveLength(2);
    expect(new Set(received.map((r) => r.dedupeKey)).size).toBe(2);
    expect(received.every((r) => r.recipientId === student.accountId)).toBe(true);
  });

  it("reopen returns 409 APPLICATION_CLOSED once the requirement has a CONFIRMED application", async () => {
    const app = await createTestApp();
    const { student } = await createStudent();
    const requirement = await createRequirement({ studentId: student.id });
    const { tutor, actor: tutorActor } = await createPlainTutor();
    const withdrawn = await createApplication({
      requirementId: requirement.id,
      tutorId: tutor.id,
      studentId: student.id,
      initiatedBy: "TUTOR",
      status: "WITHDRAWN",
    });
    const { tutor: winner } = await createPlainTutor();
    await createApplication({
      requirementId: requirement.id,
      tutorId: winner.id,
      studentId: student.id,
      initiatedBy: "TUTOR",
      status: "CONFIRMED",
    });

    const res = await app.inject({
      method: "POST",
      url: `${BASE}/applications/${withdrawn.id}/reopen`,
      headers: tutorActor.headers,
    });

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("APPLICATION_CLOSED");
    expect((await statusOf(withdrawn.id)).status).toBe("WITHDRAWN");
  });
});

describe("cancel and complete", () => {
  async function setupConfirmed() {
    const app = await createTestApp();
    const { student, actor: studentActor } = await createStudent();
    const requirement = await createRequirement({ studentId: student.id, salary: 5000 });
    const { tutor, actor: tutorActor } = await createPlainTutor();
    const application = await createApplication({
      requirementId: requirement.id,
      tutorId: tutor.id,
      studentId: student.id,
      initiatedBy: "TUTOR",
    });
    const confirm = await app.inject({
      method: "POST",
      url: `${BASE}/applications/${application.id}/confirm`,
      headers: studentActor.headers,
    });
    expect(confirm.statusCode).toBe(200);
    return { app, application, studentActor, tutorActor };
  }

  it("cancel sets CANCELLED with endedAt and voids the DUE placement fee", async () => {
    await setCommission(10);
    const { app, application, tutorActor } = await setupConfirmed();
    expect(await prisma.platformFee.count({ where: { applicationId: application.id } })).toBe(1);

    const res = await app.inject({
      method: "POST",
      url: `${BASE}/applications/${application.id}/cancel`,
      headers: tutorActor.headers,
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ status: "CANCELLED", allowedActions: [] });
    const row = await statusOf(application.id);
    expect(row.status).toBe("CANCELLED");
    expect(row.endedAt).toBeInstanceOf(Date);
    const fees = await prisma.platformFee.findMany({ where: { applicationId: application.id } });
    expect(fees.map((f) => f.status)).toEqual(["VOID"]);
  });

  it("complete sets COMPLETED with endedAt, and a cancel after that returns 409", async () => {
    const { app, application, studentActor, tutorActor } = await setupConfirmed();

    const done = await app.inject({
      method: "POST",
      url: `${BASE}/applications/${application.id}/complete`,
      headers: studentActor.headers,
    });
    expect(done.statusCode).toBe(200);
    expect(JSON.parse(done.body).status).toBe("COMPLETED");
    const row = await statusOf(application.id);
    expect(row.status).toBe("COMPLETED");
    expect(row.endedAt).toBeInstanceOf(Date);

    const cancel = await app.inject({
      method: "POST",
      url: `${BASE}/applications/${application.id}/cancel`,
      headers: tutorActor.headers,
    });
    expect(cancel.statusCode).toBe(409);
    expect(JSON.parse(cancel.body).code).toBe("INVALID_APPLICATION_STATE");
  });
});

describe("reads", () => {
  it("GET /applications is scoped per role, filters by status, and pages with a cursor", async () => {
    const app = await createTestApp();
    const { student, actor: studentActor } = await createStudent();
    const { tutor, actor: tutorActor } = await createPlainTutor();
    const { tutor: other, actor: otherActor } = await createPlainTutor();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const requirement = await createRequirement({ studentId: student.id });
      const application = await createApplication({
        requirementId: requirement.id,
        tutorId: tutor.id,
        studentId: student.id,
        initiatedBy: "TUTOR",
      });
      await prisma.application.update({
        where: { id: application.id },
        data: { appliedAt: new Date(Date.UTC(2026, 0, 1 + i)) },
      });
      ids.push(application.id);
    }
    // Newest first, so the first id in the list is the last one created.
    const newestFirst = [...ids].reverse();
    const otherReq = await createRequirement({ studentId: student.id });
    await createApplication({
      requirementId: otherReq.id,
      tutorId: other.id,
      studentId: student.id,
      initiatedBy: "TUTOR",
    });

    const first = await app.inject({
      method: "GET",
      url: `${BASE}/applications?limit=2`,
      headers: tutorActor.headers,
    });
    expect(first.statusCode).toBe(200);
    const page1 = JSON.parse(first.body);
    expect(page1.applications.map((a: { id: string }) => a.id)).toEqual(newestFirst.slice(0, 2));
    expect(page1.nextCursor).toEqual(expect.any(String));

    const second = await app.inject({
      method: "GET",
      url: `${BASE}/applications?limit=2&cursor=${encodeURIComponent(page1.nextCursor)}`,
      headers: tutorActor.headers,
    });
    const page2 = JSON.parse(second.body);
    expect(page2.applications.map((a: { id: string }) => a.id)).toEqual([newestFirst[2]]);
    expect(page2.nextCursor).toBeNull();

    // Students see only applications addressed to them as the student side.
    const asStudent = await app.inject({
      method: "GET",
      url: `${BASE}/applications`,
      headers: studentActor.headers,
    });
    expect(JSON.parse(asStudent.body).applications).toHaveLength(4);

    // The other tutor sees only its own application.
    const asOther = await app.inject({
      method: "GET",
      url: `${BASE}/applications`,
      headers: otherActor.headers,
    });
    expect(JSON.parse(asOther.body).applications).toHaveLength(1);

    // Status filter.
    const pending = await app.inject({
      method: "GET",
      url: `${BASE}/applications?status=CONFIRMED`,
      headers: tutorActor.headers,
    });
    expect(JSON.parse(pending.body).applications).toEqual([]);
  });

  it("GET /applications/:id hides the counterpart contact until CONFIRMED, then shows it", async () => {
    const app = await createTestApp();
    const { student, actor: studentActor } = await createStudent();
    const requirement = await createRequirement({ studentId: student.id });
    const { tutor, actor: tutorActor } = await createPlainTutor();
    const application = await createApplication({
      requirementId: requirement.id,
      tutorId: tutor.id,
      studentId: student.id,
      initiatedBy: "TUTOR",
    });

    const before = await app.inject({
      method: "GET",
      url: `${BASE}/applications/${application.id}`,
      headers: tutorActor.headers,
    });
    expect(JSON.parse(before.body).counterpartContact).toBeNull();

    await app.inject({
      method: "POST",
      url: `${BASE}/applications/${application.id}/confirm`,
      headers: studentActor.headers,
    });

    const tutorView = await app.inject({
      method: "GET",
      url: `${BASE}/applications/${application.id}`,
      headers: tutorActor.headers,
    });
    expect(JSON.parse(tutorView.body).counterpartContact).toEqual({
      phoneNumber: student.phoneNumber,
      whatsappNumber: student.whatsappNumber,
    });

    const studentView = await app.inject({
      method: "GET",
      url: `${BASE}/applications/${application.id}`,
      headers: studentActor.headers,
    });
    expect(JSON.parse(studentView.body).counterpartContact).toEqual({
      phoneNumber: (await prisma.tutor.findUniqueOrThrow({ where: { id: tutor.id } })).phoneNumber,
      whatsappNumber: null,
    });
  });

  it("shows the placement fee to the tutor only", async () => {
    const app = await createTestApp();
    await setCommission(10);
    const { student, actor: studentActor } = await createStudent();
    const requirement = await createRequirement({ studentId: student.id, salary: 5000 });
    const { tutor, actor: tutorActor } = await createPlainTutor();
    const application = await createApplication({
      requirementId: requirement.id,
      tutorId: tutor.id,
      studentId: student.id,
      initiatedBy: "TUTOR",
    });
    await app.inject({
      method: "POST",
      url: `${BASE}/applications/${application.id}/confirm`,
      headers: studentActor.headers,
    });

    const tutorView = JSON.parse(
      (
        await app.inject({
          method: "GET",
          url: `${BASE}/applications/${application.id}`,
          headers: tutorActor.headers,
        })
      ).body,
    );
    expect(tutorView.fee).toMatchObject({
      amountDue: "500.00",
      amountPaid: "0.00",
      status: "DUE",
      unpaid: false,
      dueDate: dhakaDatePlus(7),
    });

    const studentView = JSON.parse(
      (
        await app.inject({
          method: "GET",
          url: `${BASE}/applications/${application.id}`,
          headers: studentActor.headers,
        })
      ).body,
    );
    expect(studentView.fee).toBeNull();
  });

  it("returns the right allowedActions for each side at each stage", async () => {
    const app = await createTestApp();
    const { student, actor: studentActor } = await createStudent();
    const requirement = await createRequirement({ studentId: student.id });
    const { tutor, actor: tutorActor } = await createPlainTutor();
    const application = await createApplication({
      requirementId: requirement.id,
      tutorId: tutor.id,
      studentId: student.id,
      initiatedBy: "TUTOR",
    });

    const read = async (headers: Record<string, string>) =>
      JSON.parse(
        (
          await app.inject({
            method: "GET",
            url: `${BASE}/applications/${application.id}`,
            headers,
          })
        ).body,
      ).allowedActions;

    expect(await read(tutorActor.headers)).toEqual(["withdraw"]);
    expect(await read(studentActor.headers)).toEqual(["confirm", "reject"]);

    await app.inject({
      method: "POST",
      url: `${BASE}/applications/${application.id}/confirm`,
      headers: studentActor.headers,
    });

    expect(await read(tutorActor.headers)).toEqual(["cancel", "complete"]);
    expect(await read(studentActor.headers)).toEqual(["cancel", "complete"]);
  });

  it("GET /requirements/:id/applications is visible only to the requirement's student", async () => {
    const app = await createTestApp();
    const { student, actor: studentActor } = await createStudent();
    const { actor: otherStudent } = await createStudent();
    const requirement = await createRequirement({ studentId: student.id });
    const { tutor } = await createPlainTutor();
    await createApplication({
      requirementId: requirement.id,
      tutorId: tutor.id,
      studentId: student.id,
      initiatedBy: "TUTOR",
    });

    const owner = await app.inject({
      method: "GET",
      url: `${BASE}/requirements/${requirement.id}/applications`,
      headers: studentActor.headers,
    });
    expect(owner.statusCode).toBe(200);
    expect(JSON.parse(owner.body).applications).toHaveLength(1);

    const stranger = await app.inject({
      method: "GET",
      url: `${BASE}/requirements/${requirement.id}/applications`,
      headers: otherStudent.headers,
    });
    expect(stranger.statusCode).toBe(404);
  });

  it("GET /packages/:id/applications is visible only to the package's tutor", async () => {
    const app = await createTestApp();
    const { tutor, actor: tutorActor } = await createPlainTutor();
    await prisma.tutor.update({ where: { id: tutor.id }, data: { isListed: true } });
    const pkg = await createTuitionPackage(tutor.id);
    const { actor: studentActor } = await createStudent();
    await app.inject({
      method: "POST",
      url: `${BASE}/packages/${pkg.id}/applications`,
      headers: studentActor.headers,
    });

    const owner = await app.inject({
      method: "GET",
      url: `${BASE}/packages/${pkg.id}/applications`,
      headers: tutorActor.headers,
    });
    expect(owner.statusCode).toBe(200);
    expect(JSON.parse(owner.body).applications).toHaveLength(1);

    const { actor: otherTutor } = await createPlainTutor();
    const stranger = await app.inject({
      method: "GET",
      url: `${BASE}/packages/${pkg.id}/applications`,
      headers: otherTutor.headers,
    });
    expect(stranger.statusCode).toBe(404);
  });
});
