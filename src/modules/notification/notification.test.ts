import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import type { AppNotificationKind } from "../../generated/prisma/enums.js";
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
import { hardDeleteAccount } from "../auth/auth.service.js";
import { notifyUpload } from "../files/upload-review.service.js";

const API = "/api/v1";
const NOTIFY = `${API}/notifications`;

type Account = Awaited<ReturnType<typeof createAccount>>;
type Actor = { account: Account; headers: Record<string, string> };

type AlertJson = {
  id: string;
  kind: string;
  applicationId: string | null;
  listingKind: "REQUIREMENT" | "PACKAGE" | null;
  counterpartName: string | null;
  note: string | null;
  filePurpose: string | null;
  blocksVideos: boolean | null;
  blocksDocuments: boolean | null;
  readAt: string | null;
  createdAt: string;
};
type ListJson = { notifications: AlertJson[]; nextCursor: string | null; unreadCount: number };

async function actorFor(account: Account): Promise<Actor> {
  return { account, headers: await getAuthHeaders(account) };
}

async function createTutor(name = "Test Tutor", overrides: { isListed?: boolean } = {}) {
  const account = await createAccount({ role: "TUTOR" });
  const tutor = await createTutorProfile(account.id, { name });
  if (overrides.isListed) {
    // is_listed is written only by recompute_is_listed() in SQL, so flip it through the same path as the apps tests.
    await prisma.tutor.update({ where: { id: tutor.id }, data: { isListed: true } });
  }
  return { tutor, actor: await actorFor(account) };
}

// A tutor that passes the apply gate, so the write path can run through the API.
async function createReadyTutor(name = "Test Tutor") {
  const { tutor, actor } = await createTutor(name);
  await setTutorLocation(tutor.id);
  const area = await createArea();
  await prisma.tutorArea.create({ data: { tutorId: tutor.id, areaId: area.id } });
  const subject = await createSubject();
  await prisma.tutorSubject.create({ data: { tutorId: tutor.id, subjectId: subject.id } });
  await createTutorRequirement(tutor.id, { isDefault: true, subjectIds: [subject.id] });
  return { tutor, actor };
}

async function createStudent(name = "Test Student") {
  const account = await createAccount({ role: "STUDENT" });
  const area = await createArea();
  const student = await createStudentProfile(account.id, area.id, { name });
  return { student, actor: await actorFor(account) };
}

async function seedAlert(
  recipientId: string,
  applicationId: string,
  createdAt: Date,
  kind: AppNotificationKind = "APPLICATION_RECEIVED",
) {
  return prisma.appNotification.create({ data: { recipientId, applicationId, kind, createdAt } });
}

async function listAs(app: FastifyInstance, actor: Actor, query = ""): Promise<ListJson> {
  const res = await app.inject({ method: "GET", url: `${NOTIFY}${query}`, headers: actor.headers });
  expect(res.statusCode).toBe(200);
  return JSON.parse(res.body);
}

async function kindsOf(app: FastifyInstance, actor: Actor): Promise<string[]> {
  return (await listAs(app, actor)).notifications.map((n) => n.kind);
}

async function unreadOf(app: FastifyInstance, actor: Actor): Promise<number> {
  const res = await app.inject({
    method: "GET",
    url: `${NOTIFY}/unread-count`,
    headers: actor.headers,
  });
  expect(res.statusCode).toBe(200);
  return JSON.parse(res.body).count;
}

// A tutor-initiated requirement application that is PENDING, CONFIRMED or as given.
async function requirementApplication(
  studentId: string,
  tutorId: string,
  status: "PENDING" | "CONFIRMED" = "PENDING",
) {
  const requirement = await createRequirement({ studentId, salary: 5000 });
  const application = await createApplication({
    requirementId: requirement.id,
    tutorId,
    studentId,
    initiatedBy: "TUTOR",
    status,
  });
  return { requirement, application };
}

describe("alerts written by application actions", () => {
  it("apply to a requirement alerts the student with APPLICATION_RECEIVED", async () => {
    const app = await createTestApp();
    const { student, actor: studentActor } = await createStudent("Sara Student");
    const requirement = await createRequirement({ studentId: student.id });
    const { actor: tutorActor } = await createReadyTutor("Rahim Tutor");

    const res = await app.inject({
      method: "POST",
      url: `${API}/requirements/${requirement.id}/applications`,
      headers: tutorActor.headers,
    });
    expect(res.statusCode).toBe(201);
    const applicationId = JSON.parse(res.body).id;

    const studentView = await listAs(app, studentActor);
    expect(studentView.notifications).toHaveLength(1);
    expect(studentView.notifications[0]).toMatchObject({
      kind: "APPLICATION_RECEIVED",
      applicationId,
      listingKind: "REQUIREMENT",
      counterpartName: "Rahim Tutor",
      readAt: null,
    });
    expect(await kindsOf(app, tutorActor)).toEqual([]);
  });

  it("request a package alerts the tutor with PACKAGE_REQUESTED", async () => {
    const app = await createTestApp();
    const { tutor, actor: tutorActor } = await createTutor("Nadia Tutor", { isListed: true });
    const pkg = await createTuitionPackage(tutor.id);
    const { actor: studentActor } = await createStudent("Omar Student");

    const res = await app.inject({
      method: "POST",
      url: `${API}/packages/${pkg.id}/applications`,
      headers: studentActor.headers,
    });
    expect(res.statusCode).toBe(201);
    const applicationId = JSON.parse(res.body).id;

    const tutorView = await listAs(app, tutorActor);
    expect(tutorView.notifications).toHaveLength(1);
    expect(tutorView.notifications[0]).toMatchObject({
      kind: "PACKAGE_REQUESTED",
      applicationId,
      listingKind: "PACKAGE",
      counterpartName: "Omar Student",
    });
    expect(await kindsOf(app, studentActor)).toEqual([]);
  });

  it("confirm alerts the initiator with APPLICATION_ACCEPTED and each auto-rejected tutor with LISTING_FILLED", async () => {
    const app = await createTestApp();
    const { student, actor: studentActor } = await createStudent("Sara Student");
    const requirement = await createRequirement({ studentId: student.id, salary: 5000 });
    const { tutor: tutorA, actor: tutorAActor } = await createTutor("Tutor A");
    const { tutor: tutorB, actor: tutorBActor } = await createTutor("Tutor B");
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

    const res = await app.inject({
      method: "POST",
      url: `${API}/applications/${appA.id}/confirm`,
      headers: studentActor.headers,
    });
    expect(res.statusCode).toBe(200);

    const winner = await listAs(app, tutorAActor);
    expect(winner.notifications).toHaveLength(1);
    expect(winner.notifications[0]).toMatchObject({
      kind: "APPLICATION_ACCEPTED",
      applicationId: appA.id,
      listingKind: "REQUIREMENT",
      counterpartName: "Sara Student",
    });

    const loser = await listAs(app, tutorBActor);
    expect(loser.notifications).toHaveLength(1);
    expect(loser.notifications[0]).toMatchObject({
      kind: "LISTING_FILLED",
      applicationId: appB.id,
      listingKind: "REQUIREMENT",
    });
    expect((await prisma.application.findUniqueOrThrow({ where: { id: appB.id } })).status).toBe(
      "REJECTED",
    );

    expect(await kindsOf(app, studentActor)).toEqual([]);
  });

  it("confirming a package alerts the chosen student and the other requesting students with LISTING_FILLED", async () => {
    const app = await createTestApp();
    const { tutor, actor: tutorActor } = await createTutor("Nadia Tutor", { isListed: true });
    const pkg = await createTuitionPackage(tutor.id);
    const { student: studentA, actor: studentAActor } = await createStudent("Student A");
    const { student: studentB, actor: studentBActor } = await createStudent("Student B");
    const appA = await createApplication({
      packageId: pkg.id,
      tutorId: tutor.id,
      studentId: studentA.id,
      initiatedBy: "STUDENT",
    });
    const appB = await createApplication({
      packageId: pkg.id,
      tutorId: tutor.id,
      studentId: studentB.id,
      initiatedBy: "STUDENT",
    });

    const res = await app.inject({
      method: "POST",
      url: `${API}/applications/${appA.id}/confirm`,
      headers: tutorActor.headers,
    });
    expect(res.statusCode).toBe(200);

    const chosen = await listAs(app, studentAActor);
    expect(chosen.notifications).toHaveLength(1);
    expect(chosen.notifications[0]).toMatchObject({
      kind: "APPLICATION_ACCEPTED",
      applicationId: appA.id,
      listingKind: "PACKAGE",
      counterpartName: "Nadia Tutor",
    });

    const other = await listAs(app, studentBActor);
    expect(other.notifications).toHaveLength(1);
    expect(other.notifications[0]).toMatchObject({
      kind: "LISTING_FILLED",
      applicationId: appB.id,
      listingKind: "PACKAGE",
      counterpartName: "Nadia Tutor",
    });

    expect(await kindsOf(app, tutorActor)).toEqual([]);
  });

  it("reject alerts the initiator with APPLICATION_DECLINED", async () => {
    const app = await createTestApp();
    const { student, actor: studentActor } = await createStudent();
    const { tutor, actor: tutorActor } = await createTutor("Rahim Tutor");
    const { application } = await requirementApplication(student.id, tutor.id);

    const res = await app.inject({
      method: "POST",
      url: `${API}/applications/${application.id}/reject`,
      headers: studentActor.headers,
    });
    expect(res.statusCode).toBe(200);

    const tutorView = await listAs(app, tutorActor);
    expect(tutorView.notifications).toHaveLength(1);
    expect(tutorView.notifications[0]).toMatchObject({
      kind: "APPLICATION_DECLINED",
      applicationId: application.id,
      counterpartName: "Test Student",
    });
    expect(await kindsOf(app, studentActor)).toEqual([]);
  });

  it("withdraw alerts the counterparty with APPLICATION_WITHDRAWN", async () => {
    const app = await createTestApp();
    const { student, actor: studentActor } = await createStudent();
    const { tutor, actor: tutorActor } = await createTutor("Rahim Tutor");
    const { application } = await requirementApplication(student.id, tutor.id);

    const res = await app.inject({
      method: "POST",
      url: `${API}/applications/${application.id}/withdraw`,
      headers: tutorActor.headers,
    });
    expect(res.statusCode).toBe(200);

    const studentView = await listAs(app, studentActor);
    expect(studentView.notifications).toHaveLength(1);
    expect(studentView.notifications[0]).toMatchObject({
      kind: "APPLICATION_WITHDRAWN",
      applicationId: application.id,
      counterpartName: "Rahim Tutor",
    });
    expect(await kindsOf(app, tutorActor)).toEqual([]);
  });

  it("reopen alerts the counterparty with APPLICATION_REOPENED", async () => {
    const app = await createTestApp();
    const { student, actor: studentActor } = await createStudent();
    const requirement = await createRequirement({ studentId: student.id });
    const { actor: tutorActor } = await createReadyTutor("Rahim Tutor");

    const applied = await app.inject({
      method: "POST",
      url: `${API}/requirements/${requirement.id}/applications`,
      headers: tutorActor.headers,
    });
    const applicationId = JSON.parse(applied.body).id;
    await app.inject({
      method: "POST",
      url: `${API}/applications/${applicationId}/withdraw`,
      headers: tutorActor.headers,
    });
    const reopened = await app.inject({
      method: "POST",
      url: `${API}/applications/${applicationId}/reopen`,
      headers: tutorActor.headers,
    });
    expect(reopened.statusCode).toBe(200);

    expect((await kindsOf(app, studentActor)).sort()).toEqual(
      ["APPLICATION_RECEIVED", "APPLICATION_WITHDRAWN", "APPLICATION_REOPENED"].sort(),
    );
    const reopenedAlert = (await listAs(app, studentActor)).notifications.find(
      (n) => n.kind === "APPLICATION_REOPENED",
    );
    expect(reopenedAlert).toMatchObject({
      applicationId,
      listingKind: "REQUIREMENT",
      counterpartName: "Rahim Tutor",
    });
    expect(await kindsOf(app, tutorActor)).toEqual([]);
  });

  it("cancel alerts the counterparty with APPLICATION_CANCELLED", async () => {
    const app = await createTestApp();
    const { student, actor: studentActor } = await createStudent();
    const { tutor, actor: tutorActor } = await createTutor("Rahim Tutor");
    const { application } = await requirementApplication(student.id, tutor.id, "CONFIRMED");

    const res = await app.inject({
      method: "POST",
      url: `${API}/applications/${application.id}/cancel`,
      headers: tutorActor.headers,
    });
    expect(res.statusCode).toBe(200);

    const studentView = await listAs(app, studentActor);
    expect(studentView.notifications).toHaveLength(1);
    expect(studentView.notifications[0]).toMatchObject({
      kind: "APPLICATION_CANCELLED",
      applicationId: application.id,
      counterpartName: "Rahim Tutor",
    });
    expect(await kindsOf(app, tutorActor)).toEqual([]);
  });

  it("complete alerts the counterparty with APPLICATION_COMPLETED", async () => {
    const app = await createTestApp();
    const { student, actor: studentActor } = await createStudent();
    const { tutor, actor: tutorActor } = await createTutor("Rahim Tutor");
    const { application } = await requirementApplication(student.id, tutor.id, "CONFIRMED");

    const res = await app.inject({
      method: "POST",
      url: `${API}/applications/${application.id}/complete`,
      headers: studentActor.headers,
    });
    expect(res.statusCode).toBe(200);

    const tutorView = await listAs(app, tutorActor);
    expect(tutorView.notifications).toHaveLength(1);
    expect(tutorView.notifications[0]).toMatchObject({
      kind: "APPLICATION_COMPLETED",
      applicationId: application.id,
      counterpartName: "Test Student",
    });
    expect(await kindsOf(app, studentActor)).toEqual([]);
  });
});

describe("GET /api/v1/notifications", () => {
  it("returns the notification shape with counterpartName and listingKind", async () => {
    const app = await createTestApp();
    const { student, actor } = await createStudent();
    const { tutor } = await createTutor("Rahim Tutor");
    const { application } = await requirementApplication(student.id, tutor.id);
    await seedAlert(student.accountId, application.id, new Date("2026-01-01T00:00:00Z"));

    const body = await listAs(app, actor);

    expect(body.nextCursor).toBeNull();
    expect(body.unreadCount).toBe(1);
    expect(body.notifications).toHaveLength(1);
    const [row] = body.notifications;
    expect(Object.keys(row).sort()).toEqual(
      [
        "applicationId",
        "blocksDocuments",
        "blocksVideos",
        "counterpartName",
        "createdAt",
        "filePurpose",
        "id",
        "kind",
        "listingKind",
        "note",
        "readAt",
        "requirementId",
      ].sort(),
    );
    expect(row).toMatchObject({
      kind: "APPLICATION_RECEIVED",
      applicationId: application.id,
      listingKind: "REQUIREMENT",
      counterpartName: "Rahim Tutor",
      readAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("pages newest first with a keyset cursor and a default limit of 20", async () => {
    const app = await createTestApp();
    const { student, actor } = await createStudent();
    const { tutor } = await createTutor();
    const { application } = await requirementApplication(student.id, tutor.id);
    const base = Date.UTC(2026, 0, 1);
    await prisma.appNotification.createMany({
      data: Array.from({ length: 21 }, (_, i) => ({
        recipientId: student.accountId,
        applicationId: application.id,
        kind: "APPLICATION_RECEIVED" as const,
        createdAt: new Date(base + i * 1000),
      })),
    });
    const newestFirst = (
      await prisma.appNotification.findMany({
        where: { recipientId: student.accountId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { id: true },
      })
    ).map((row) => row.id);

    const first = await listAs(app, actor);
    expect(first.notifications).toHaveLength(20);
    expect(first.notifications.map((n) => n.id)).toEqual(newestFirst.slice(0, 20));
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(first.unreadCount).toBe(21);

    const second = await listAs(
      app,
      actor,
      `?cursor=${encodeURIComponent(first.nextCursor ?? "")}`,
    );
    expect(second.notifications.map((n) => n.id)).toEqual([newestFirst[20]]);
    expect(second.nextCursor).toBeNull();
  });

  it("honours limit and walks every page with the cursor", async () => {
    const app = await createTestApp();
    const { student, actor } = await createStudent();
    const { tutor } = await createTutor();
    const { application } = await requirementApplication(student.id, tutor.id);
    const base = Date.UTC(2026, 0, 1);
    const created: { id: string }[] = [];
    for (let i = 0; i < 5; i++) {
      created.push(await seedAlert(student.accountId, application.id, new Date(base + i * 1000)));
    }
    const newestFirst = created.map((row) => row.id).reverse();

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query = cursor ? `?limit=2&cursor=${encodeURIComponent(cursor)}` : "?limit=2";
      const page: ListJson = await listAs(app, actor, query);
      seen.push(...page.notifications.map((n) => n.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor);

    expect(pages).toBe(3);
    expect(seen).toEqual(newestFirst);
  });

  it("rejects a limit outside 1-50 and a malformed cursor with 400", async () => {
    const app = await createTestApp();
    const { actor } = await createStudent();

    for (const query of ["?limit=0", "?limit=51", "?cursor=not-a-cursor"]) {
      const res = await app.inject({
        method: "GET",
        url: `${NOTIFY}${query}`,
        headers: actor.headers,
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe("VALIDATION_ERROR");
    }
  });

  it("requires a signed-in account", async () => {
    const app = await createTestApp();
    const res = await app.inject({ method: "GET", url: NOTIFY });
    expect(res.statusCode).toBe(401);
  });

  it("gives an admin an empty list", async () => {
    const app = await createTestApp();
    const { student } = await createStudent();
    const { tutor } = await createTutor();
    const { application } = await requirementApplication(student.id, tutor.id);
    await seedAlert(student.accountId, application.id, new Date());
    const admin = await actorFor(await createAccount({ role: "ADMIN" }));

    expect(await listAs(app, admin)).toEqual({
      notifications: [],
      nextCursor: null,
      unreadCount: 0,
    });
  });
});

describe("GET /api/v1/notifications/unread-count", () => {
  it("counts unread alerts and drops to zero after read-all", async () => {
    const app = await createTestApp();
    const { student, actor } = await createStudent();
    const { tutor } = await createTutor();
    const { application } = await requirementApplication(student.id, tutor.id);
    await seedAlert(student.accountId, application.id, new Date());
    await seedAlert(student.accountId, application.id, new Date());

    expect(await unreadOf(app, actor)).toBe(2);

    await app.inject({ method: "POST", url: `${NOTIFY}/read-all`, headers: actor.headers });

    expect(await unreadOf(app, actor)).toBe(0);
  });
});

describe("POST /api/v1/notifications/:id/read", () => {
  it("replies 204, marks my alert read, and is idempotent", async () => {
    const app = await createTestApp();
    const { student, actor } = await createStudent();
    const { tutor } = await createTutor();
    const { application } = await requirementApplication(student.id, tutor.id);
    const alert = await seedAlert(student.accountId, application.id, new Date());

    const first = await app.inject({
      method: "POST",
      url: `${NOTIFY}/${alert.id}/read`,
      headers: actor.headers,
    });
    expect(first.statusCode).toBe(204);
    const readAt = (await prisma.appNotification.findUniqueOrThrow({ where: { id: alert.id } }))
      .readAt;
    expect(readAt).toBeInstanceOf(Date);
    expect(await unreadOf(app, actor)).toBe(0);

    const again = await app.inject({
      method: "POST",
      url: `${NOTIFY}/${alert.id}/read`,
      headers: actor.headers,
    });
    expect(again.statusCode).toBe(204);
    expect(
      (await prisma.appNotification.findUniqueOrThrow({ where: { id: alert.id } })).readAt,
    ).toEqual(readAt);
  });

  it("returns 404 for another account's alert and leaves it unread", async () => {
    const app = await createTestApp();
    const { student, actor: owner } = await createStudent();
    const { actor: stranger } = await createStudent();
    const { tutor } = await createTutor();
    const { application } = await requirementApplication(student.id, tutor.id);
    const alert = await seedAlert(student.accountId, application.id, new Date());

    const res = await app.inject({
      method: "POST",
      url: `${NOTIFY}/${alert.id}/read`,
      headers: stranger.headers,
    });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).code).toBe("NOT_FOUND");
    expect(await unreadOf(app, owner)).toBe(1);
  });

  it("returns 404 for an id that does not exist", async () => {
    const app = await createTestApp();
    const { actor } = await createStudent();

    const res = await app.inject({
      method: "POST",
      url: `${NOTIFY}/${randomUUID()}/read`,
      headers: actor.headers,
    });

    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/v1/notifications/read-all", () => {
  it("replies 204 and marks only the caller's alerts read", async () => {
    const app = await createTestApp();
    const { student, actor: studentActor } = await createStudent();
    const { student: otherStudent, actor: otherActor } = await createStudent();
    const { tutor } = await createTutor();
    const { application } = await requirementApplication(student.id, tutor.id);
    const { application: otherApplication } = await requirementApplication(
      otherStudent.id,
      tutor.id,
    );
    await seedAlert(student.accountId, application.id, new Date());
    await seedAlert(student.accountId, application.id, new Date());
    await seedAlert(otherStudent.accountId, otherApplication.id, new Date());

    const res = await app.inject({
      method: "POST",
      url: `${NOTIFY}/read-all`,
      headers: studentActor.headers,
    });

    expect(res.statusCode).toBe(204);
    expect(await unreadOf(app, studentActor)).toBe(0);
    expect(await unreadOf(app, otherActor)).toBe(1);
  });
});

describe("isolation", () => {
  it("one user never sees another user's alerts", async () => {
    const app = await createTestApp();
    const { student: studentA, actor: actorA } = await createStudent("Student A");
    const { student: studentB, actor: actorB } = await createStudent("Student B");
    const { tutor, actor: tutorActor } = await createTutor("Tutor");
    const { application: appA } = await requirementApplication(studentA.id, tutor.id);
    const { application: appB } = await requirementApplication(studentB.id, tutor.id);
    const alertA = await seedAlert(studentA.accountId, appA.id, new Date());
    const alertB = await seedAlert(studentB.accountId, appB.id, new Date());
    const tutorAlert = await seedAlert(tutor.accountId, appB.id, new Date());

    expect((await listAs(app, actorA)).notifications.map((n) => n.id)).toEqual([alertA.id]);
    expect((await listAs(app, actorB)).notifications.map((n) => n.id)).toEqual([alertB.id]);
    expect((await listAs(app, tutorActor)).notifications.map((n) => n.id)).toEqual([tutorAlert.id]);
    expect(await unreadOf(app, actorA)).toBe(1);
    expect(await unreadOf(app, actorB)).toBe(1);
    expect(await unreadOf(app, tutorActor)).toBe(1);
  });
});

// Upload alerts have no application. The note is stored only when the admin shared it.
async function uploadAlert(
  recipientId: string,
  input: {
    kind: Parameters<typeof notifyUpload>[1]["kind"];
    note?: string | null;
    noteVisible?: boolean;
    filePurpose?: Parameters<typeof notifyUpload>[1]["filePurpose"];
    blocksVideos?: boolean;
    blocksDocuments?: boolean;
  },
) {
  await prisma.$transaction((tx) =>
    notifyUpload(tx, {
      recipientId,
      noteVisible: true,
      note: null,
      ...input,
    }),
  );
}

describe("upload alerts", () => {
  it("list returns the upload alert with null application fields and the shared note", async () => {
    const app = await createTestApp();
    const { student, actor } = await createStudent();
    await uploadAlert(student.accountId, {
      kind: "ID_REJECTED",
      note: "The photo is blurry.",
      filePurpose: "STUDENT_ID",
    });

    const body = await listAs(app, actor);

    expect(body.notifications).toHaveLength(1);
    expect(body.notifications[0]).toMatchObject({
      kind: "ID_REJECTED",
      applicationId: null,
      listingKind: null,
      counterpartName: null,
      note: "The photo is blurry.",
      filePurpose: "STUDENT_ID",
      blocksVideos: null,
      blocksDocuments: null,
      readAt: null,
    });
  });

  it("stores a hidden note as null so the user never receives it", async () => {
    const app = await createTestApp();
    const { student, actor } = await createStudent();
    await uploadAlert(student.accountId, {
      kind: "VIDEO_REJECTED",
      note: "Internal: duplicate of an earlier upload.",
      noteVisible: false,
      filePurpose: "TUTOR_VIDEO",
    });

    const [row] = (await listAs(app, actor)).notifications;
    expect(row).toMatchObject({ kind: "VIDEO_REJECTED", note: null, filePurpose: "TUTOR_VIDEO" });
    const stored = await prisma.appNotification.findFirstOrThrow({
      where: { recipientId: student.accountId },
    });
    expect(stored.note).toBeNull();
  });

  it("block alerts carry which uploads are covered and no file purpose", async () => {
    const app = await createTestApp();
    const { student, actor } = await createStudent();
    await uploadAlert(student.accountId, {
      kind: "UPLOADS_BLOCKED",
      note: "Please wait for a call from our team.",
      blocksVideos: true,
      blocksDocuments: false,
    });

    const [row] = (await listAs(app, actor)).notifications;
    expect(row).toMatchObject({
      kind: "UPLOADS_BLOCKED",
      applicationId: null,
      listingKind: null,
      counterpartName: null,
      note: "Please wait for a call from our team.",
      filePurpose: null,
      blocksVideos: true,
      blocksDocuments: false,
    });
  });

  it("application alerts keep their values and get null upload fields", async () => {
    const app = await createTestApp();
    const { student, actor } = await createStudent();
    const { tutor } = await createTutor("Rahim Tutor");
    const { application } = await requirementApplication(student.id, tutor.id);
    await seedAlert(student.accountId, application.id, new Date());

    const [row] = (await listAs(app, actor)).notifications;
    expect(row).toMatchObject({
      kind: "APPLICATION_RECEIVED",
      applicationId: application.id,
      listingKind: "REQUIREMENT",
      counterpartName: "Rahim Tutor",
      note: null,
      filePurpose: null,
      blocksVideos: null,
      blocksDocuments: null,
    });
  });

  it("upload alerts count toward the unread count and can be marked read", async () => {
    const app = await createTestApp();
    const { student, actor } = await createStudent();
    await uploadAlert(student.accountId, {
      kind: "FILE_REMOVED",
      note: "Removed.",
      filePurpose: "CREDENTIAL",
    });
    await uploadAlert(student.accountId, { kind: "UPLOADS_UNBLOCKED", note: null });
    expect(await unreadOf(app, actor)).toBe(2);

    const [first] = (await listAs(app, actor)).notifications;
    const res = await app.inject({
      method: "POST",
      url: `${NOTIFY}/${first.id}/read`,
      headers: actor.headers,
    });
    expect(res.statusCode).toBe(204);
    expect(await unreadOf(app, actor)).toBe(1);
    const readRow = (await listAs(app, actor)).notifications.find((n) => n.id === first.id);
    expect(readRow?.readAt).not.toBeNull();
  });

  it("read-all clears upload alerts too", async () => {
    const app = await createTestApp();
    const { student, actor } = await createStudent();
    await uploadAlert(student.accountId, {
      kind: "UPLOADS_BLOCKED",
      note: "Paused.",
      blocksVideos: true,
      blocksDocuments: true,
    });

    const res = await app.inject({
      method: "POST",
      url: `${NOTIFY}/read-all`,
      headers: actor.headers,
    });
    expect(res.statusCode).toBe(204);
    expect(await unreadOf(app, actor)).toBe(0);
  });
});

describe("account deletion", () => {
  it("hard-deleting an account removes the alerts addressed to it and keeps others", async () => {
    const { student } = await createStudent();
    const { tutor } = await createTutor();
    const { student: otherStudent } = await createStudent();
    const { application } = await requirementApplication(student.id, tutor.id);
    const { application: otherApplication } = await requirementApplication(
      otherStudent.id,
      tutor.id,
    );
    await seedAlert(student.accountId, application.id, new Date());
    const kept = await seedAlert(tutor.accountId, otherApplication.id, new Date());

    await hardDeleteAccount(student.accountId);

    expect(await prisma.appNotification.count({ where: { recipientId: student.accountId } })).toBe(
      0,
    );
    expect(await prisma.appNotification.findUnique({ where: { id: kept.id } })).not.toBeNull();
  });
});
