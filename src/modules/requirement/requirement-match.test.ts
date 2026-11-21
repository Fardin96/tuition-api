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
  createTutorProfile,
  createTutorRequirement,
  createTutorZone,
  getAuthHeaders,
  setStudentLocation,
  setTutorLocation,
} from "../../tests/helpers.js";

const BASE = "/api/v1/requirements";
const NOTIFY = "/api/v1/notifications";

const TUTOR_PIN = { lat: 23.8103, lng: 90.4125 }; // inside Dhaka city
const SAVAR = { lat: 23.8583, lng: 90.2667 }; // outside the city, well past the 2 km edge

async function createTutor({
  isListed = true,
  pin = TUTOR_PIN,
}: {
  isListed?: boolean;
  pin?: { lat: number; lng: number } | null;
} = {}) {
  const account = await createAccount({ role: "TUTOR" });
  const tutor = await createTutorProfile(account.id, { isListed });
  if (pin) await setTutorLocation(tutor.id, pin);
  return { tutor, headers: await getAuthHeaders(account) };
}

async function createStudentAt(pin: { lat: number; lng: number } | null = TUTOR_PIN) {
  const area = await createArea();
  const account = await createAccount({ role: "STUDENT" });
  const student = await createStudentProfile(account.id, area.id, { name: "Amina Rahman" });
  if (pin) await setStudentLocation(student.id, pin);
  return { student, headers: await getAuthHeaders(account) };
}

// A default set that covers the subject with the default requirement shape (Dhaka, levels 6-10).
// With a zone it is home-tuition in the city; without zones it is online-only.
async function addDefaultSet(
  tutorId: string,
  subjectId: number,
  { zone = true, teachesOnline = true }: { zone?: boolean; teachesOnline?: boolean } = {},
) {
  await prisma.tutorSubject.createMany({
    data: [{ tutorId, subjectId }],
    skipDuplicates: true,
  });
  const zoneIds = zone ? [await createTutorZone(tutorId, { radiusM: 5000 })] : [];
  const set = await createTutorRequirement(tutorId, {
    isDefault: true,
    subjectIds: [subjectId],
    zoneIds,
  });
  if (teachesOnline) return set;
  return prisma.tutorRequirement.update({ where: { id: set.id }, data: { teachesOnline: false } });
}

async function listTutors(headers: Record<string, string>, requirementId: string, query = "") {
  const app = await createTestApp();
  const res = await app.inject({
    method: "GET",
    url: `${BASE}/${requirementId}/tutors${query}`,
    headers,
  });
  return { status: res.statusCode, headers: res.headers, body: JSON.parse(res.body) };
}

async function invite(headers: Record<string, string>, requirementId: string, tutorId: string) {
  const app = await createTestApp();
  const res = await app.inject({
    method: "POST",
    url: `${BASE}/${requirementId}/invites`,
    headers,
    payload: { tutorId },
  });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

describe("GET /requirements/:id/tutors (student's matching tutors)", () => {
  it("is limited to the owning student: 404 for another student and for an unknown id", async () => {
    const { student } = await createStudentAt();
    const subject = await createSubject();
    const req = await createRequirement({ studentId: student.id, subjectIds: [subject.id] });
    const other = await createStudentAt();

    const foreign = await listTutors(other.headers, req.id);
    expect(foreign.status).toBe(404);
    expect(foreign.body).toMatchObject({ code: "NOT_FOUND", message: "Requirement not found" });

    const { headers: ownerHeaders } = await createStudentAt();
    const unknown = await listTutors(ownerHeaders, req.id);
    expect(unknown.status).toBe(404);
  });

  it("returns 409 LISTING_NOT_OPEN when the requirement is not OPEN", async () => {
    const { student, headers } = await createStudentAt();
    const subject = await createSubject();
    const closed = await createRequirement({
      studentId: student.id,
      subjectIds: [subject.id],
      status: "CLOSED",
    });

    const res = await listTutors(headers, closed.id);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("LISTING_NOT_OPEN");
  });

  it("lists a listed tutor with a matching set, with reasons and no numeric score", async () => {
    const { student, headers } = await createStudentAt();
    const math = await createSubject();
    const req = await createRequirement({ studentId: student.id, subjectIds: [math.id] });
    const { tutor } = await createTutor();
    await addDefaultSet(tutor.id, math.id);

    const res = await listTutors(headers, req.id);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.body).toMatchObject({
      total: 1,
      page: 1,
      hasMore: false,
      matchVersion: 0,
      suggestions: [],
    });
    const [row] = res.body.tutors;
    expect(row.tutor).toMatchObject({
      id: tutor.id,
      name: "Test Tutor",
      areas: [],
      subjects: [{ id: math.id }],
    });
    expect(row.reasons.length).toBeGreaterThan(0);
    expect(row.reasons[0]).toEqual({
      rule: expect.any(String),
      ok: expect.any(Boolean),
      label: expect.any(String),
    });
    expect(row).not.toHaveProperty("score");
    expect(row.tutor).not.toHaveProperty("score");
    expect(row).toMatchObject({ invitedAt: null, application: null });
  });

  it("leaves out an unlisted tutor, even with a matching set", async () => {
    const { student, headers } = await createStudentAt();
    const math = await createSubject();
    const req = await createRequirement({ studentId: student.id, subjectIds: [math.id] });
    const { tutor } = await createTutor({ isListed: false });
    await addDefaultSet(tutor.id, math.id);

    const res = await listTutors(headers, req.id);
    expect(res.body.tutors).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  it("leaves out a tutor whose application the student rejected, and shows a pending application", async () => {
    const { student, headers } = await createStudentAt();
    const math = await createSubject();
    const req = await createRequirement({ studentId: student.id, subjectIds: [math.id] });
    const { tutor: rejected } = await createTutor();
    await addDefaultSet(rejected.id, math.id);
    await createApplication({
      requirementId: req.id,
      tutorId: rejected.id,
      studentId: student.id,
      initiatedBy: "TUTOR",
      status: "REJECTED",
    });
    const { tutor: pending } = await createTutor();
    await addDefaultSet(pending.id, math.id);
    const application = await createApplication({
      requirementId: req.id,
      tutorId: pending.id,
      studentId: student.id,
      initiatedBy: "TUTOR",
    });

    const res = await listTutors(headers, req.id);
    expect(res.body.tutors.map((t: { tutor: { id: string } }) => t.tutor.id)).toEqual([pending.id]);
    expect(res.body.tutors[0].application).toEqual({ id: application.id, status: "PENDING" });
  });

  it("shows invitedAt for a tutor this student invited", async () => {
    const { student, headers } = await createStudentAt();
    const math = await createSubject();
    const req = await createRequirement({ studentId: student.id, subjectIds: [math.id] });
    const { tutor } = await createTutor();
    await addDefaultSet(tutor.id, math.id);
    const invitedAt = new Date("2026-04-01T09:00:00.000Z");
    await prisma.requirementInvite.create({
      data: {
        requirementId: req.id,
        tutorId: tutor.id,
        studentId: student.id,
        createdAt: invitedAt,
      },
    });

    const res = await listTutors(headers, req.id);
    expect(res.body.tutors[0].invitedAt).toBe(invitedAt.toISOString());
  });

  it("suggests ALLOW_ONLINE when the only tutor teaches online and lives outside Dhaka", async () => {
    const { student, headers } = await createStudentAt();
    const math = await createSubject();
    const req = await createRequirement({ studentId: student.id, subjectIds: [math.id] });
    const { tutor } = await createTutor({ pin: SAVAR });
    // No zones: the set is online-only, so it cannot reach a student in Dhaka at home.
    await addDefaultSet(tutor.id, math.id, { zone: false, teachesOnline: true });

    const res = await listTutors(headers, req.id);
    expect(res.body.tutors).toEqual([]);
    expect(res.body.total).toBe(0);
    expect(res.body.suggestions).toEqual([{ code: "ALLOW_ONLINE", extraTutors: 1 }]);
  });

  it("gives no suggestions at 3 or more tutors", async () => {
    const { student, headers } = await createStudentAt();
    const math = await createSubject();
    const req = await createRequirement({ studentId: student.id, subjectIds: [math.id] });
    for (let i = 0; i < 3; i++) {
      const { tutor } = await createTutor();
      await addDefaultSet(tutor.id, math.id);
    }

    const res = await listTutors(headers, req.id);
    expect(res.body.total).toBe(3);
    expect(res.body.suggestions).toEqual([]);
  });
});

describe("POST /requirements/:id/invites (student invites a tutor)", () => {
  it("creates the invite (201) and alerts the tutor with the requirement and the student's name", async () => {
    const { student, headers } = await createStudentAt();
    const math = await createSubject();
    const req = await createRequirement({ studentId: student.id, subjectIds: [math.id] });
    const { tutor, headers: tutorHeaders } = await createTutor();

    const res = await invite(headers, req.id, tutor.id);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ requirementId: req.id, tutorId: tutor.id });
    expect(res.body.id).toEqual(expect.any(String));
    expect(res.body.createdAt).toEqual(expect.any(String));

    const app = await createTestApp();
    const list = await app.inject({ method: "GET", url: NOTIFY, headers: tutorHeaders });
    const alerts = JSON.parse(list.body).notifications;
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      kind: "REQUIREMENT_INVITED",
      requirementId: req.id,
      applicationId: null,
      listingKind: "REQUIREMENT",
      counterpartName: "Amina Rahman",
    });

    const stored = await prisma.requirementInvite.findUnique({
      where: { requirementId_tutorId: { requirementId: req.id, tutorId: tutor.id } },
    });
    expect(stored?.studentId).toBe(student.id);
  });

  it("returns 409 INVITE_EXISTS on a second invite to the same tutor", async () => {
    const { student, headers } = await createStudentAt();
    const math = await createSubject();
    const req = await createRequirement({ studentId: student.id, subjectIds: [math.id] });
    const { tutor } = await createTutor();

    expect((await invite(headers, req.id, tutor.id)).status).toBe(201);
    const again = await invite(headers, req.id, tutor.id);
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({
      code: "INVITE_EXISTS",
      message: "You already invited this tutor",
    });
  });

  it("returns 409 ALREADY_APPLIED when the tutor already applied", async () => {
    const { student, headers } = await createStudentAt();
    const math = await createSubject();
    const req = await createRequirement({ studentId: student.id, subjectIds: [math.id] });
    const { tutor } = await createTutor();
    await createApplication({
      requirementId: req.id,
      tutorId: tutor.id,
      studentId: student.id,
      initiatedBy: "TUTOR",
    });

    const res = await invite(headers, req.id, tutor.id);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: "ALREADY_APPLIED",
      message: "This tutor already applied",
    });
  });

  it("returns 409 APPLICATION_CLOSED when the requirement already has a confirmed application", async () => {
    const { student, headers } = await createStudentAt();
    const math = await createSubject();
    const req = await createRequirement({ studentId: student.id, subjectIds: [math.id] });
    const { tutor: winner } = await createTutor();
    await createApplication({
      requirementId: req.id,
      tutorId: winner.id,
      studentId: student.id,
      initiatedBy: "TUTOR",
      status: "CONFIRMED",
    });
    const { tutor } = await createTutor();

    const res = await invite(headers, req.id, tutor.id);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("APPLICATION_CLOSED");
  });

  it("returns 404 for an unlisted tutor, and for a requirement that is not the caller's", async () => {
    const { student, headers } = await createStudentAt();
    const math = await createSubject();
    const req = await createRequirement({ studentId: student.id, subjectIds: [math.id] });
    const { tutor: unlisted } = await createTutor({ isListed: false });

    const hidden = await invite(headers, req.id, unlisted.id);
    expect(hidden.status).toBe(404);
    expect(hidden.body).toMatchObject({ code: "NOT_FOUND", message: "Tutor not found" });

    const { tutor } = await createTutor();
    const other = await createStudentAt();
    const foreign = await invite(other.headers, req.id, tutor.id);
    expect(foreign.status).toBe(404);
    expect(foreign.body.message).toBe("Requirement not found");
  });

  it("returns 409 LISTING_NOT_OPEN when the requirement is not OPEN", async () => {
    const { student, headers } = await createStudentAt();
    const math = await createSubject();
    const closed = await createRequirement({
      studentId: student.id,
      subjectIds: [math.id],
      status: "CLOSED",
    });
    const { tutor } = await createTutor();

    const res = await invite(headers, closed.id, tutor.id);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("LISTING_NOT_OPEN");
  });

  it("returns 409 INVITE_LIMIT_REACHED once the requirement has 20 invites", async () => {
    const { student, headers } = await createStudentAt();
    const math = await createSubject();
    const req = await createRequirement({ studentId: student.id, subjectIds: [math.id] });
    const invitees: string[] = [];
    for (let i = 0; i < 21; i++) {
      const { tutor } = await createTutor();
      invitees.push(tutor.id);
    }
    await prisma.requirementInvite.createMany({
      data: invitees.slice(0, 20).map((tutorId) => ({
        requirementId: req.id,
        tutorId,
        studentId: student.id,
      })),
    });

    const res = await invite(headers, req.id, invitees[20]);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: "INVITE_LIMIT_REACHED",
      message: "You can invite up to 20 tutors to one requirement",
    });
  });
});
