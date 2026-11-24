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
  setPlatformSetting,
  setTutorLocation,
} from "../../tests/helpers.js";

const BASE = "/api/v1";
const DAY_MS = 24 * 60 * 60 * 1000;

// A tutor that passes the apply gate (see application.test.ts).
async function createReadyTutor() {
  const account = await createAccount({ role: "TUTOR" });
  const tutor = await createTutorProfile(account.id);
  await setTutorLocation(tutor.id);
  const area = await createArea();
  await prisma.tutorArea.create({ data: { tutorId: tutor.id, areaId: area.id } });
  const subject = await createSubject();
  await prisma.tutorSubject.create({ data: { tutorId: tutor.id, subjectId: subject.id } });
  await createTutorRequirement(tutor.id, { isDefault: true, subjectIds: [subject.id] });
  return { tutor, headers: await getAuthHeaders(account) };
}

async function createPlainTutor(isListed = false) {
  const account = await createAccount({ role: "TUTOR" });
  const tutor = await createTutorProfile(account.id, { isListed });
  return { tutor, headers: await getAuthHeaders(account) };
}

async function createStudent() {
  const account = await createAccount({ role: "STUDENT" });
  const area = await createArea();
  const student = await createStudentProfile(account.id, area.id);
  return { student, headers: await getAuthHeaders(account) };
}

type App = Awaited<ReturnType<typeof createTestApp>>;
type Kind = "application" | "package_request" | "accept";

async function post(app: App, url: string, headers: Record<string, string>) {
  return app.inject({ method: "POST", url: `${BASE}${url}`, headers });
}

// A send or accept already on the record: what a real action would have written.
function recordSend(partyId: string, kind: Kind, at = new Date()) {
  return prisma.dailyAction.create({ data: { partyId, kind, at } });
}

// Applies to a fresh requirement of the student's; returns the application id.
async function applyTo(app: App, studentId: string, headers: Record<string, string>) {
  const requirement = await createRequirement({ studentId });
  const res = await post(app, `/requirements/${requirement.id}/applications`, headers);
  expect(res.statusCode).toBe(201);
  return JSON.parse(res.body).id as string;
}

describe("daily limits (rolling 24 hours)", () => {
  describe("applications (#57)", () => {
    it("lets a tutor apply up to the limit", async () => {
      const app = await createTestApp();
      await setPlatformSetting("daily_application_limit", 2);
      const { student } = await createStudent();
      const { headers } = await createReadyTutor();

      await applyTo(app, student.id, headers);
      await applyTo(app, student.id, headers);
    });

    it("answers 429 DAILY_LIMIT_REACHED at the limit, with resetsAt 24 h after the oldest counted send", async () => {
      const app = await createTestApp();
      await setPlatformSetting("daily_application_limit", 2);
      const { student } = await createStudent();
      const { tutor, headers } = await createReadyTutor();
      await applyTo(app, student.id, headers);
      await applyTo(app, student.id, headers);
      const third = await createRequirement({ studentId: student.id });

      const res = await post(app, `/requirements/${third.id}/applications`, headers);

      expect(res.statusCode).toBe(429);
      const body = JSON.parse(res.body);
      expect(body.code).toBe("DAILY_LIMIT_REACHED");
      expect(body.message).toBe("You can send 2 applications in 24 hours.");
      expect(body.details.limit).toBe(2);
      const oldest = await prisma.dailyAction.findFirstOrThrow({
        where: { partyId: tutor.id, kind: "application" },
        orderBy: { at: "asc" },
      });
      expect(body.details.resetsAt).toBe(new Date(oldest.at.getTime() + DAY_MS).toISOString());
      expect(await prisma.application.count({ where: { tutorId: tutor.id } })).toBe(2);
    });

    it("counts withdrawn applications", async () => {
      const app = await createTestApp();
      await setPlatformSetting("daily_application_limit", 2);
      const { student } = await createStudent();
      const { headers } = await createReadyTutor();
      const first = await applyTo(app, student.id, headers);
      await post(app, `/applications/${first}/withdraw`, headers);
      await applyTo(app, student.id, headers);

      const third = await createRequirement({ studentId: student.id });
      const res = await post(app, `/requirements/${third.id}/applications`, headers);

      expect(res.statusCode).toBe(429);
      expect(JSON.parse(res.body).code).toBe("DAILY_LIMIT_REACHED");
    });

    it("answers a repeat apply at the limit with 409 ALREADY_APPLIED, not 429", async () => {
      const app = await createTestApp();
      await setPlatformSetting("daily_application_limit", 2);
      const { student } = await createStudent();
      const { headers } = await createReadyTutor();
      const first = await createRequirement({ studentId: student.id });
      expect((await post(app, `/requirements/${first.id}/applications`, headers)).statusCode).toBe(
        201,
      );
      await applyTo(app, student.id, headers);

      const res = await post(app, `/requirements/${first.id}/applications`, headers);

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).code).toBe("ALREADY_APPLIED");
    });

    it("ignores sends older than 24 hours", async () => {
      const app = await createTestApp();
      await setPlatformSetting("daily_application_limit", 2);
      const { student } = await createStudent();
      const { tutor, headers } = await createReadyTutor();
      const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
      await recordSend(tutor.id, "application", old);
      await recordSend(tutor.id, "application", old);

      const requirement = await createRequirement({ studentId: student.id });
      const res = await post(app, `/requirements/${requirement.id}/applications`, headers);

      expect(res.statusCode).toBe(201);
    });

    it("drops a send at exactly 24 hours old, and counts one 1 minute younger", async () => {
      const app = await createTestApp();
      await setPlatformSetting("daily_application_limit", 1);
      const { student } = await createStudent();
      const { tutor, headers } = await createReadyTutor();
      await recordSend(tutor.id, "application", new Date(Date.now() - DAY_MS));

      const first = await createRequirement({ studentId: student.id });
      expect((await post(app, `/requirements/${first.id}/applications`, headers)).statusCode).toBe(
        201,
      );

      // The send just made fills the limit of 1; a 1-minute-younger send would block the next one too.
      await prisma.dailyAction.deleteMany({ where: { partyId: tutor.id } });
      const younger = new Date(Date.now() - DAY_MS + 60 * 1000);
      await recordSend(tutor.id, "application", younger);
      const second = await createRequirement({ studentId: student.id });
      const res = await post(app, `/requirements/${second.id}/applications`, headers);

      expect(res.statusCode).toBe(429);
      expect(JSON.parse(res.body).details.resetsAt).toBe(
        new Date(younger.getTime() + DAY_MS).toISOString(),
      );
    });

    it("caps simultaneous applies: one 201 and one 429 at the last slot", async () => {
      const app = await createTestApp();
      await setPlatformSetting("daily_application_limit", 2);
      const { student } = await createStudent();
      const { tutor, headers } = await createReadyTutor();
      await recordSend(tutor.id, "application");
      const [a, b] = [
        await createRequirement({ studentId: student.id }),
        await createRequirement({ studentId: student.id }),
      ];

      const results = await Promise.all([
        post(app, `/requirements/${a.id}/applications`, headers),
        post(app, `/requirements/${b.id}/applications`, headers),
      ]);

      expect(results.map((r) => r.statusCode).sort()).toEqual([201, 429]);
    });

    it("uses the lowered limit on sends already made, and resets from the newest of them", async () => {
      const app = await createTestApp();
      const { student } = await createStudent();
      const { tutor, headers } = await createReadyTutor();
      await applyTo(app, student.id, headers);
      await applyTo(app, student.id, headers);
      await applyTo(app, student.id, headers);
      await setPlatformSetting("daily_application_limit", 1);
      const newest = await prisma.dailyAction.findFirstOrThrow({
        where: { partyId: tutor.id, kind: "application" },
        orderBy: { at: "desc" },
      });

      const next = await createRequirement({ studentId: student.id });
      const res = await post(app, `/requirements/${next.id}/applications`, headers);

      expect(res.statusCode).toBe(429);
      const body = JSON.parse(res.body);
      expect(body.details).toEqual({
        limit: 1,
        resetsAt: new Date(newest.at.getTime() + DAY_MS).toISOString(),
      });
      expect(body.message).toBe("You can send 1 application in 24 hours.");
    });
  });

  describe("withdraw and reopen", () => {
    it("caps a withdraw and reopen cycle on one application", async () => {
      const app = await createTestApp();
      await setPlatformSetting("daily_application_limit", 2);
      const { student } = await createStudent();
      const { headers } = await createReadyTutor();
      const id = await applyTo(app, student.id, headers);
      await post(app, `/applications/${id}/withdraw`, headers);
      expect((await post(app, `/applications/${id}/reopen`, headers)).statusCode).toBe(200);
      await post(app, `/applications/${id}/withdraw`, headers);

      const res = await post(app, `/applications/${id}/reopen`, headers);

      expect(res.statusCode).toBe(429);
      expect(JSON.parse(res.body).code).toBe("DAILY_LIMIT_REACHED");
    });

    it("counts a reopen as a send, so it can be blocked by other sends", async () => {
      const app = await createTestApp();
      await setPlatformSetting("daily_application_limit", 2);
      const { student } = await createStudent();
      const { headers } = await createReadyTutor();
      const id = await applyTo(app, student.id, headers);
      await post(app, `/applications/${id}/withdraw`, headers);
      await applyTo(app, student.id, headers);

      const res = await post(app, `/applications/${id}/reopen`, headers);

      expect(res.statusCode).toBe(429);
    });

    it("counts a student's reopen of a package request", async () => {
      const app = await createTestApp();
      await setPlatformSetting("daily_package_request_limit", 1);
      const { tutor } = await createPlainTutor(true);
      const pkg = await createTuitionPackage(tutor.id);
      const { headers } = await createStudent();
      const requested = await post(app, `/packages/${pkg.id}/applications`, headers);
      const id = JSON.parse(requested.body).id;
      await post(app, `/applications/${id}/withdraw`, headers);

      const res = await post(app, `/applications/${id}/reopen`, headers);

      expect(res.statusCode).toBe(429);
      expect(JSON.parse(res.body).message).toBe("You can request 1 package in 24 hours.");
    });
  });

  describe("package requests (#58)", () => {
    it("limits a student's package requests", async () => {
      const app = await createTestApp();
      await setPlatformSetting("daily_package_request_limit", 2);
      const { tutor } = await createPlainTutor(true);
      const { headers } = await createStudent();
      const packages = [];
      for (let i = 0; i < 3; i++) packages.push(await createTuitionPackage(tutor.id));

      for (const pkg of packages.slice(0, 2)) {
        expect((await post(app, `/packages/${pkg.id}/applications`, headers)).statusCode).toBe(201);
      }
      const res = await post(app, `/packages/${packages[2].id}/applications`, headers);

      expect(res.statusCode).toBe(429);
      const body = JSON.parse(res.body);
      expect(body.code).toBe("DAILY_LIMIT_REACHED");
      expect(body.message).toBe("You can request 2 packages in 24 hours.");
      expect(body.details.limit).toBe(2);
    });
  });

  describe("accepts (confirm)", () => {
    it("limits a student's confirms across requirements", async () => {
      const app = await createTestApp();
      await setPlatformSetting("daily_accept_limit", 2);
      const { student, headers: studentHeaders } = await createStudent();
      const { tutor } = await createPlainTutor();
      await recordSend(student.id, "accept");
      const pending = [];
      for (let i = 0; i < 2; i++) {
        const requirement = await createRequirement({ studentId: student.id });
        pending.push(
          await createApplication({
            requirementId: requirement.id,
            tutorId: tutor.id,
            studentId: student.id,
            initiatedBy: "TUTOR",
          }),
        );
      }

      const second = await post(app, `/applications/${pending[0].id}/confirm`, studentHeaders);
      expect(second.statusCode).toBe(200);

      const third = await post(app, `/applications/${pending[1].id}/confirm`, studentHeaders);
      expect(third.statusCode).toBe(429);
      expect(JSON.parse(third.body).code).toBe("DAILY_LIMIT_REACHED");
      expect(JSON.parse(third.body).message).toBe("You can accept 2 applications in 24 hours.");
    });

    it("limits a tutor's confirms of package requests", async () => {
      const app = await createTestApp();
      await setPlatformSetting("daily_accept_limit", 2);
      const { tutor, headers: tutorHeaders } = await createPlainTutor(true);
      const { student } = await createStudent();
      await recordSend(tutor.id, "accept");
      const requests = [];
      for (let i = 0; i < 2; i++) {
        const pkg = await createTuitionPackage(tutor.id);
        requests.push(
          await createApplication({
            packageId: pkg.id,
            tutorId: tutor.id,
            studentId: student.id,
            initiatedBy: "STUDENT",
          }),
        );
      }

      const second = await post(app, `/applications/${requests[0].id}/confirm`, tutorHeaders);
      expect(second.statusCode).toBe(200);

      const third = await post(app, `/applications/${requests[1].id}/confirm`, tutorHeaders);
      expect(third.statusCode).toBe(429);
      expect(JSON.parse(third.body).code).toBe("DAILY_LIMIT_REACHED");
      expect(JSON.parse(third.body).message).toBe("You can accept 2 package requests in 24 hours.");
    });

    it("keeps a student's confirms apart from the tutor's accepts", async () => {
      const app = await createTestApp();
      await setPlatformSetting("daily_accept_limit", 1);
      const { student, headers: studentHeaders } = await createStudent();
      const { tutor, headers: tutorHeaders } = await createPlainTutor(true);
      const requirement = await createRequirement({ studentId: student.id });
      const offer = await createApplication({
        requirementId: requirement.id,
        tutorId: tutor.id,
        studentId: student.id,
        initiatedBy: "TUTOR",
      });
      const pkg = await createTuitionPackage(tutor.id);
      const request = await createApplication({
        packageId: pkg.id,
        tutorId: tutor.id,
        studentId: student.id,
        initiatedBy: "STUDENT",
      });

      expect(
        (await post(app, `/applications/${offer.id}/confirm`, studentHeaders)).statusCode,
      ).toBe(200);
      expect(
        (await post(app, `/applications/${request.id}/confirm`, tutorHeaders)).statusCode,
      ).toBe(200);
    });
  });
});
