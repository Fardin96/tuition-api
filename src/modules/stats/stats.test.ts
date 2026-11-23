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

const URL = "/api/v1/me/stats";

async function setup() {
  const app = await createTestApp();
  const area = await createArea();
  return { app, area };
}

async function newStudent(areaId: number) {
  const account = await createAccount({ role: "STUDENT" });
  const student = await createStudentProfile(account.id, areaId);
  return { account, student };
}

async function newTutor() {
  const account = await createAccount({ role: "TUTOR" });
  const tutor = await createTutorProfile(account.id);
  return { account, tutor };
}

async function applicationOf(
  student: { id: string },
  tutor: { id: string },
  initiatedBy: "TUTOR" | "STUDENT",
  status:
    | "PENDING"
    | "CONFIRMED"
    | "COMPLETED"
    | "REJECTED"
    | "WITHDRAWN"
    | "CANCELLED"
    | "EXPIRED",
) {
  // Not OPEN, so these requirements never count as the student's open ones.
  const requirement = await createRequirement({ studentId: student.id, status: "CLOSED" });
  return createApplication({
    requirementId: requirement.id,
    tutorId: tutor.id,
    studentId: student.id,
    initiatedBy,
    status,
  });
}

describe("GET /api/v1/me/stats", () => {
  it("returns zeros for a tutor and a student with no activity", async () => {
    const { app } = await setup();
    const tutor = await newTutor();
    const student = await createAccount({ role: "STUDENT" });
    const tutorRes = await app.inject({
      method: "GET",
      url: URL,
      headers: await getAuthHeaders(tutor.account),
    });
    expect(tutorRes.statusCode).toBe(200);
    expect(tutorRes.json()).toEqual({
      role: "TUTOR",
      applicationsSent: 0,
      activeStudents: 0,
      invitesReceived: 0,
    });
    expect(tutorRes.headers["cache-control"]).toBe("private, no-store");

    // A student account without a profile reads as zeros too.
    const studentRes = await app.inject({
      method: "GET",
      url: URL,
      headers: await getAuthHeaders(student),
    });
    expect(studentRes.json()).toEqual({
      role: "STUDENT",
      openRequirements: 0,
      applicationsReceived: 0,
      tutorsHired: 0,
    });
  });

  it("counts a tutor's sent applications in every status and active students distinctly", async () => {
    const { app, area } = await setup();
    const tutor = await newTutor();
    const a = await newStudent(area.id);
    const b = await newStudent(area.id);
    const c = await newStudent(area.id);
    const d = await newStudent(area.id);
    const rows = [
      [a, "CONFIRMED"],
      [a, "CONFIRMED"], // same student twice: counted once as an active student
      [b, "CONFIRMED"],
      [c, "COMPLETED"], // finished work is not an active student
      [c, "PENDING"],
      [c, "WITHDRAWN"],
      [a, "REJECTED"],
      [b, "CANCELLED"],
      [c, "EXPIRED"],
    ] as const;
    for (const [s, status] of rows) {
      await applicationOf(s.student, tutor.tutor, "TUTOR", status);
    }
    // Sent by the student, so the tutor did not send it.
    await applicationOf(d.student, tutor.tutor, "STUDENT", "PENDING");

    const res = await app.inject({
      method: "GET",
      url: URL,
      headers: await getAuthHeaders(tutor.account),
    });
    expect(res.json()).toEqual({
      role: "TUTOR",
      applicationsSent: 9,
      activeStudents: 2,
      invitesReceived: 0,
    });
  });

  it("counts invites only to OPEN requirements from ACTIVE students", async () => {
    const { app, area } = await setup();
    const tutor = await newTutor();
    const student = await newStudent(area.id);
    const open = await createRequirement({ studentId: student.student.id, status: "OPEN" });
    const closed = await createRequirement({ studentId: student.student.id, status: "CLOSED" });
    const blocked = await createAccount({ role: "STUDENT", status: "BLOCKED" });
    const blockedStudent = await createStudentProfile(blocked.id, area.id);
    const blockedRequirement = await createRequirement({
      studentId: blockedStudent.id,
      status: "OPEN",
    });
    for (const requirement of [open, closed, blockedRequirement]) {
      await prisma.requirementInvite.create({
        data: {
          requirementId: requirement.id,
          tutorId: tutor.tutor.id,
          studentId: requirement.studentId,
        },
      });
    }

    const res = await app.inject({
      method: "GET",
      url: URL,
      headers: await getAuthHeaders(tutor.account),
    });
    expect(res.json()).toMatchObject({ role: "TUTOR", invitesReceived: 1 });
  });

  it("counts a student's open requirements, received applications and distinct hires", async () => {
    const { app, area } = await setup();
    const student = await newStudent(area.id);
    const t1 = await newTutor();
    const t2 = await newTutor();
    const t3 = await newTutor();
    await createRequirement({ studentId: student.student.id, status: "OPEN" });
    await createRequirement({ studentId: student.student.id, status: "OPEN" });
    await createRequirement({ studentId: student.student.id, status: "CLOSED" });
    await createRequirement({ studentId: student.student.id, status: "DRAFT" });

    await applicationOf(student.student, t1.tutor, "TUTOR", "CONFIRMED");
    await applicationOf(student.student, t1.tutor, "TUTOR", "COMPLETED"); // same tutor: hired once
    await applicationOf(student.student, t2.tutor, "TUTOR", "CONFIRMED");
    await applicationOf(student.student, t2.tutor, "TUTOR", "PENDING");
    await applicationOf(student.student, t3.tutor, "TUTOR", "REJECTED");
    await applicationOf(student.student, t3.tutor, "TUTOR", "EXPIRED");
    // Sent by the student, so not received, but a confirmed hire counts whoever sent it.
    await applicationOf(student.student, t3.tutor, "STUDENT", "CONFIRMED");

    const res = await app.inject({
      method: "GET",
      url: URL,
      headers: await getAuthHeaders(student.account),
    });
    expect(res.json()).toEqual({
      role: "STUDENT",
      openRequirements: 2,
      applicationsReceived: 6,
      tutorsHired: 3,
    });
  });

  it("requires a signed-in student or tutor", async () => {
    const { app } = await setup();
    const anonymous = await app.inject({ method: "GET", url: URL });
    expect(anonymous.statusCode).toBe(401);

    const admin = await createAdmin();
    const asAdmin = await app.inject({
      method: "GET",
      url: URL,
      headers: await getAuthHeaders(admin),
    });
    expect(asAdmin.statusCode).toBe(403);
  });
});
