import { describe, expect, it } from "vitest";
import { prisma } from "../../lib/prisma.js";
import {
  createAccount,
  createApplication,
  createArea,
  createStudentProfile,
  createSubject,
  createTestApp,
  createTuitionPackage,
  createTutorProfile,
  createTutorRequirement,
  createTutorZone,
  getAuthHeaders,
  setPlatformSetting,
  setTutorLocation,
} from "../../tests/helpers.js";

const BASE = "/api/v1/packages";

type Actor = {
  account: { id: string; role: "TUTOR" | "STUDENT" };
  headers: Record<string, string>;
};

// A tutor that passes the apply gate: name, address, pin, area, phone and one teaching subject on the
// profile. Listed, so students can see its packages. The default requirement set is optional: packages
// carry their own subjects and zones, so only the profile gate applies to them.
async function createReadyTutor({ defaultSet = true }: { defaultSet?: boolean } = {}) {
  const account = await createAccount({ role: "TUTOR" });
  const tutor = await createTutorProfile(account.id, { isListed: true });
  await setTutorLocation(tutor.id);
  const area = await createArea();
  await prisma.tutorArea.create({ data: { tutorId: tutor.id, areaId: area.id } });
  const subject = await createSubject();
  await prisma.tutorSubject.create({ data: { tutorId: tutor.id, subjectId: subject.id } });
  if (defaultSet) {
    await createTutorRequirement(tutor.id, { isDefault: true, subjectIds: [subject.id] });
  }
  return {
    tutor,
    subjectId: subject.id,
    actor: { account, headers: await getAuthHeaders(account) } as Actor,
  };
}

// A tutor with a profile but none of the apply prerequisites.
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

// A valid create body: online, Bangla medium, level 8, 17:30-19:00, three days.
function packageBody(subjectId: number, overrides: Record<string, unknown> = {}) {
  return {
    title: "SSC Math Booster",
    description: "Full syllabus revision with weekly tests.",
    coverage: "FULL_CURRICULUM",
    durationWeeks: 12,
    price: 15000,
    subjectIds: [subjectId],
    levelMin: 8,
    levelMax: 8,
    curricula: ["BANGLA_MEDIUM"],
    timeFrom: "17:30",
    timeTo: "19:00",
    daysPerWeek: 3,
    availableFrom: "2026-12-01",
    teachesOnline: true,
    zoneIds: [],
    ...overrides,
  };
}

async function send(
  method: "GET" | "POST" | "PATCH",
  url: string,
  headers: Record<string, string>,
  payload?: Record<string, unknown>,
) {
  const app = await createTestApp();
  const res = await app.inject({ method, url, headers, payload });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

function idsOf(body: { packages: { id: string }[] }) {
  return body.packages.map((p) => p.id);
}

// Dotted paths of the issues in a 400 VALIDATION_ERROR body, e.g. "zoneIds" or "levelMax".
function issuePaths(body: { issues?: { path: (string | number)[] }[] }) {
  return (body.issues ?? []).map((issue) => issue.path.join("."));
}

describe("POST /packages (tutor create, #51)", () => {
  it("creates a PENDING (awaiting admin review), OPEN, online package from a full body", async () => {
    const tutor = await createReadyTutor();

    const res = await send("POST", `${BASE}`, tutor.actor.headers, packageBody(tutor.subjectId));

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      title: "SSC Math Booster",
      coverage: "FULL_CURRICULUM",
      durationWeeks: 12,
      price: 15000,
      subjectIds: [tutor.subjectId],
      levelMin: 8,
      levelMax: 8,
      curricula: ["BANGLA_MEDIUM"],
      academicGroups: [],
      admissionTargets: [],
      timeFrom: "17:30",
      timeTo: "19:00",
      availableDays: 127,
      daysPerWeek: 3,
      maxStudents: 1,
      availableFrom: "2026-12-01",
      teachesOnline: true,
      zoneCount: 0,
      moderationStatus: "PENDING",
      status: "OPEN",
      closed: false,
      myApplication: null,
      tutor: { id: tutor.tutor.id },
    });
    expect(res.body).not.toHaveProperty("zoneIds");

    const row = await prisma.tuitionPackage.findUniqueOrThrow({
      where: { id: res.body.id },
      include: { subjects: true, zones: true },
    });
    expect(row.tutorId).toBe(tutor.tutor.id);
    expect(row.subjects.map((s) => s.subjectId)).toEqual([tutor.subjectId]);
    expect(row.zones).toEqual([]);
  });

  it("creates a package on the tutor's zones, and its zoneCount counts them", async () => {
    const tutor = await createReadyTutor();
    const zoneA = await createTutorZone(tutor.tutor.id);
    const zoneB = await createTutorZone(tutor.tutor.id, { lat: 23.75, lng: 90.39 });

    const res = await send(
      "POST",
      `${BASE}`,
      tutor.actor.headers,
      packageBody(tutor.subjectId, { teachesOnline: false, zoneIds: [zoneA, zoneB] }),
    );

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ teachesOnline: false, zoneCount: 2 });
    const zones = await prisma.packageZone.findMany({ where: { packageId: res.body.id } });
    expect(zones.map((z) => z.zoneId).sort()).toEqual([zoneA, zoneB].sort());
  });

  it("hides the new package from students until an admin approves it", async () => {
    const tutor = await createReadyTutor();
    const created = await send(
      "POST",
      `${BASE}`,
      tutor.actor.headers,
      packageBody(tutor.subjectId),
    );
    expect(created.status).toBe(201);
    const student = await createStudent();

    const before = await send("GET", `${BASE}?scope=all`, student.actor.headers);
    expect(before.status).toBe(200);
    expect(idsOf(before.body)).not.toContain(created.body.id);

    await prisma.tuitionPackage.update({
      where: { id: created.body.id },
      data: { moderationStatus: "APPROVED" },
    });
    const after = await send("GET", `${BASE}?scope=all`, student.actor.headers);
    expect(idsOf(after.body)).toContain(created.body.id);
  });

  it("returns 400 when the package has no zone and does not teach online", async () => {
    const tutor = await createReadyTutor();

    const res = await send(
      "POST",
      `${BASE}`,
      tutor.actor.headers,
      packageBody(tutor.subjectId, { teachesOnline: false, zoneIds: [] }),
    );

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(issuePaths(res.body)).toContain("zoneIds");
    expect(await prisma.tuitionPackage.count({ where: { tutorId: tutor.tutor.id } })).toBe(0);
  });

  it("returns 400 when timeTo is not after timeFrom", async () => {
    const tutor = await createReadyTutor();

    const later = await send(
      "POST",
      `${BASE}`,
      tutor.actor.headers,
      packageBody(tutor.subjectId, { timeFrom: "19:00", timeTo: "17:30" }),
    );
    const same = await send(
      "POST",
      `${BASE}`,
      tutor.actor.headers,
      packageBody(tutor.subjectId, { timeFrom: "19:00", timeTo: "19:00" }),
    );

    for (const res of [later, same]) {
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
      expect(issuePaths(res.body)).toContain("timeTo");
    }
  });

  it("returns 400 for a level range that is reversed and for groups outside levels 9 to 12", async () => {
    const tutor = await createReadyTutor();

    const reversed = await send(
      "POST",
      `${BASE}`,
      tutor.actor.headers,
      packageBody(tutor.subjectId, { levelMin: 10, levelMax: 8 }),
    );
    const groupAtLevel8 = await send(
      "POST",
      `${BASE}`,
      tutor.actor.headers,
      packageBody(tutor.subjectId, { levelMin: 8, levelMax: 8, academicGroups: ["SCIENCE"] }),
    );

    expect(reversed.status).toBe(400);
    expect(issuePaths(reversed.body)).toContain("levelMax");
    expect(groupAtLevel8.status).toBe(400);
    expect(issuePaths(groupAtLevel8.body)).toContain("academicGroups");
  });

  it("returns 400 when daysPerWeek is more than the available days", async () => {
    const tutor = await createReadyTutor();

    const res = await send(
      "POST",
      `${BASE}`,
      tutor.actor.headers,
      packageBody(tutor.subjectId, { availableDays: 1, daysPerWeek: 2 }),
    );

    expect(res.status).toBe(400);
    expect(issuePaths(res.body)).toContain("daysPerWeek");
  });

  it("returns 400 VALIDATION_ERROR when daysPerWeek is 8", async () => {
    const tutor = await createReadyTutor();

    const res = await send(
      "POST",
      `${BASE}`,
      tutor.actor.headers,
      packageBody(tutor.subjectId, { daysPerWeek: 8 }),
    );

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 INVALID_REQUIREMENT with fields [subjectIds] when the subject is not on the profile", async () => {
    const tutor = await createReadyTutor();
    const offProfile = await createSubject();

    const res = await send(
      "POST",
      `${BASE}`,
      tutor.actor.headers,
      packageBody(tutor.subjectId, { subjectIds: [offProfile.id] }),
    );

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_REQUIREMENT");
    expect(res.body.details).toEqual({ fields: ["subjectIds"] });
    expect(await prisma.tuitionPackage.count({ where: { tutorId: tutor.tutor.id } })).toBe(0);
  });

  it("adds a subject that is off the profile to the profile when syncProfileSubjects is true", async () => {
    const tutor = await createReadyTutor();
    const offProfile = await createSubject();

    const res = await send(
      "POST",
      `${BASE}`,
      tutor.actor.headers,
      packageBody(tutor.subjectId, { subjectIds: [offProfile.id], syncProfileSubjects: true }),
    );

    expect(res.status).toBe(201);
    expect(res.body.subjectIds).toEqual([offProfile.id]);
    const onProfile = await prisma.tutorSubject.findUnique({
      where: { tutorId_subjectId: { tutorId: tutor.tutor.id, subjectId: offProfile.id } },
    });
    expect(onProfile).not.toBeNull();
  });

  it("returns 400 VALIDATION_ERROR for a subject id that does not exist", async () => {
    const tutor = await createReadyTutor();

    const res = await send(
      "POST",
      `${BASE}`,
      tutor.actor.headers,
      packageBody(tutor.subjectId, { subjectIds: [999999], syncProfileSubjects: true }),
    );

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 INVALID_REQUIREMENT with fields [zoneIds] when a zone belongs to another tutor", async () => {
    const tutor = await createReadyTutor();
    const other = await createReadyTutor();
    const foreignZone = await createTutorZone(other.tutor.id);

    const res = await send(
      "POST",
      `${BASE}`,
      tutor.actor.headers,
      packageBody(tutor.subjectId, { teachesOnline: false, zoneIds: [foreignZone] }),
    );

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_REQUIREMENT");
    expect(res.body.details).toEqual({ fields: ["zoneIds"] });
  });

  it("returns 403 PROFILE_INCOMPLETE with the missing keys, and never lists default_requirement", async () => {
    const { tutor, actor } = await createPlainTutor();
    const subject = await createSubject();

    const res = await send("POST", `${BASE}`, actor.headers, packageBody(subject.id));

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("PROFILE_INCOMPLETE");
    expect(res.body.details.missing).toEqual(expect.arrayContaining(["location_pin", "area"]));
    expect(res.body.details.missing).not.toContain("default_requirement");
    expect(await prisma.tuitionPackage.count({ where: { tutorId: tutor.id } })).toBe(0);
  });

  it("lets a complete profile create a package without a default requirement set", async () => {
    const tutor = await createReadyTutor({ defaultSet: false });

    const res = await send("POST", `${BASE}`, tutor.actor.headers, packageBody(tutor.subjectId));

    expect(res.status).toBe(201);
  });

  it("returns 403 for a student", async () => {
    const tutor = await createReadyTutor();
    const student = await createStudent();

    const res = await send("POST", `${BASE}`, student.actor.headers, packageBody(tutor.subjectId));

    expect(res.status).toBe(403);
    expect(await prisma.tuitionPackage.count()).toBe(0);
  });
});

describe("GET /packages/mine (#53)", () => {
  it("lists only the caller's packages, newest first, with subjects, zones and request counts", async () => {
    const tutor = await createReadyTutor();
    const other = await createReadyTutor();
    const zone = await createTutorZone(tutor.tutor.id);

    const older = await createTuitionPackage(tutor.tutor.id, { subjectIds: [tutor.subjectId] });
    await prisma.tuitionPackage.update({
      where: { id: older.id },
      data: { createdAt: new Date("2026-01-01T00:00:00Z") },
    });
    const newer = await createTuitionPackage(tutor.tutor.id, {
      subjectIds: [tutor.subjectId],
      zoneIds: [zone],
    });
    await prisma.tuitionPackage.update({
      where: { id: newer.id },
      data: { createdAt: new Date("2026-02-01T00:00:00Z") },
    });
    const foreign = await createTuitionPackage(other.tutor.id, {
      subjectIds: [other.subjectId],
    });

    const pendingStudent = await createStudent();
    const rejectedStudent = await createStudent();
    await createApplication({
      packageId: newer.id,
      tutorId: tutor.tutor.id,
      studentId: pendingStudent.student.id,
      initiatedBy: "STUDENT",
    });
    await createApplication({
      packageId: newer.id,
      tutorId: tutor.tutor.id,
      studentId: rejectedStudent.student.id,
      initiatedBy: "STUDENT",
      status: "REJECTED",
    });

    const res = await send("GET", `${BASE}/mine`, tutor.actor.headers);

    expect(res.status).toBe(200);
    expect(idsOf(res.body)).toEqual([newer.id, older.id]);
    expect(idsOf(res.body)).not.toContain(foreign.id);

    const mine = res.body.packages.find((p: { id: string }) => p.id === newer.id);
    expect(mine).toMatchObject({
      subjectIds: [tutor.subjectId],
      zoneIds: [zone],
      zoneCount: 1,
      teachesOnline: false,
      moderationNote: null,
      pendingRequestCount: 1,
      requestCount: 2,
    });
    expect(typeof mine.updatedAt).toBe("string");
    const untouched = res.body.packages.find((p: { id: string }) => p.id === older.id);
    expect(untouched).toMatchObject({
      zoneIds: [],
      zoneCount: 0,
      pendingRequestCount: 0,
      requestCount: 0,
    });
  });

  it("returns an empty list for a tutor with no packages", async () => {
    const tutor = await createReadyTutor();

    const res = await send("GET", `${BASE}/mine`, tutor.actor.headers);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ packages: [] });
  });

  it("returns 403 for a student", async () => {
    const student = await createStudent();

    const res = await send("GET", `${BASE}/mine`, student.actor.headers);

    expect(res.status).toBe(403);
  });
});

describe("PATCH /packages/:id (#55)", () => {
  it("updates only the sent fields and keeps moderationStatus APPROVED", async () => {
    const tutor = await createReadyTutor();
    const pkg = await createTuitionPackage(tutor.tutor.id, { subjectIds: [tutor.subjectId] });

    const res = await send("PATCH", `${BASE}/${pkg.id}`, tutor.actor.headers, {
      title: "Weekend Physics",
      price: 17000,
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: pkg.id,
      title: "Weekend Physics",
      price: 17000,
      subjectIds: [tutor.subjectId],
      moderationStatus: "APPROVED",
    });
    const row = await prisma.tuitionPackage.findUniqueOrThrow({ where: { id: pkg.id } });
    expect(row.title).toBe("Weekend Physics");
    expect(row.price).toBe(17000);
    expect(row.moderationStatus).toBe("APPROVED");
  });

  it("replaces subjectIds when sent, with subjects from the profile", async () => {
    const tutor = await createReadyTutor();
    const second = await createSubject();
    await prisma.tutorSubject.create({ data: { tutorId: tutor.tutor.id, subjectId: second.id } });
    const pkg = await createTuitionPackage(tutor.tutor.id, { subjectIds: [tutor.subjectId] });

    const res = await send("PATCH", `${BASE}/${pkg.id}`, tutor.actor.headers, {
      subjectIds: [second.id],
    });

    expect(res.status).toBe(200);
    expect(res.body.subjectIds).toEqual([second.id]);
    const rows = await prisma.packageSubject.findMany({ where: { packageId: pkg.id } });
    expect(rows.map((r) => r.subjectId)).toEqual([second.id]);
  });

  it("returns 400 INVALID_REQUIREMENT for a subject off the profile, and syncProfileSubjects adds it", async () => {
    const tutor = await createReadyTutor();
    const offProfile = await createSubject();
    const pkg = await createTuitionPackage(tutor.tutor.id, { subjectIds: [tutor.subjectId] });

    const refused = await send("PATCH", `${BASE}/${pkg.id}`, tutor.actor.headers, {
      subjectIds: [offProfile.id],
    });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe("INVALID_REQUIREMENT");
    expect(refused.body.details).toEqual({ fields: ["subjectIds"] });

    const synced = await send("PATCH", `${BASE}/${pkg.id}`, tutor.actor.headers, {
      subjectIds: [offProfile.id],
      syncProfileSubjects: true,
    });
    expect(synced.status).toBe(200);
    expect(synced.body.subjectIds).toEqual([offProfile.id]);
    expect(
      await prisma.tutorSubject.findUnique({
        where: { tutorId_subjectId: { tutorId: tutor.tutor.id, subjectId: offProfile.id } },
      }),
    ).not.toBeNull();
  });

  it("replaces zoneIds when sent, and a zone of another tutor is refused", async () => {
    const tutor = await createReadyTutor();
    const other = await createReadyTutor();
    const first = await createTutorZone(tutor.tutor.id);
    const second = await createTutorZone(tutor.tutor.id, { lat: 23.75, lng: 90.39 });
    const foreign = await createTutorZone(other.tutor.id);
    const pkg = await createTuitionPackage(tutor.tutor.id, {
      subjectIds: [tutor.subjectId],
      zoneIds: [first],
    });

    const refused = await send("PATCH", `${BASE}/${pkg.id}`, tutor.actor.headers, {
      zoneIds: [foreign],
    });
    expect(refused.status).toBe(400);
    expect(refused.body.details).toEqual({ fields: ["zoneIds"] });

    const res = await send("PATCH", `${BASE}/${pkg.id}`, tutor.actor.headers, {
      zoneIds: [second],
    });
    expect(res.status).toBe(200);
    expect(res.body.zoneCount).toBe(1);
    const rows = await prisma.packageZone.findMany({ where: { packageId: pkg.id } });
    expect(rows.map((r) => r.zoneId)).toEqual([second]);
  });

  it("refuses to clear every zone unless the package teaches online", async () => {
    const tutor = await createReadyTutor();
    const zone = await createTutorZone(tutor.tutor.id);
    const pkg = await createTuitionPackage(tutor.tutor.id, {
      subjectIds: [tutor.subjectId],
      zoneIds: [zone],
    });

    const refused = await send("PATCH", `${BASE}/${pkg.id}`, tutor.actor.headers, {
      zoneIds: [],
    });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe("VALIDATION_ERROR");
    expect(issuePaths(refused.body)).toContain("zoneIds");
    expect(await prisma.packageZone.count({ where: { packageId: pkg.id } })).toBe(1);

    // The merged values count: clearing the zones and turning on teachesOnline in one request is fine.
    const res = await send("PATCH", `${BASE}/${pkg.id}`, tutor.actor.headers, {
      zoneIds: [],
      teachesOnline: true,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ zoneCount: 0, teachesOnline: true });
  });

  it("refuses to turn off teachesOnline on a package that has no zones", async () => {
    const tutor = await createReadyTutor();
    const pkg = await createTuitionPackage(tutor.tutor.id, { subjectIds: [tutor.subjectId] });

    const res = await send("PATCH", `${BASE}/${pkg.id}`, tutor.actor.headers, {
      teachesOnline: false,
    });

    expect(res.status).toBe(400);
    expect(issuePaths(res.body)).toContain("zoneIds");
  });

  it("re-checks the merged level range against the stored values, with the Invalid package message", async () => {
    const tutor = await createReadyTutor();
    const pkg = await createTuitionPackage(tutor.tutor.id, {
      subjectIds: [tutor.subjectId],
      levelMin: 6,
      levelMax: 10,
    });

    // levelMin 11 is above the stored levelMax 10.
    const res = await send("PATCH", `${BASE}/${pkg.id}`, tutor.actor.headers, { levelMin: 11 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(res.body.message).toBe("Invalid package");
    expect(issuePaths(res.body)).toContain("levelMax");
    const row = await prisma.tuitionPackage.findUniqueOrThrow({ where: { id: pkg.id } });
    expect(row.levelMin).toBe(6);
  });

  it("re-checks the stored academic groups against a narrowed level range", async () => {
    const tutor = await createReadyTutor();
    const pkg = await createTuitionPackage(tutor.tutor.id, {
      subjectIds: [tutor.subjectId],
      levelMin: 6,
      levelMax: 10,
    });
    await prisma.tuitionPackage.update({
      where: { id: pkg.id },
      data: { academicGroups: ["SCIENCE"] },
    });

    // Levels 6-8 do not reach 9 to 12, where the stored group applies.
    const res = await send("PATCH", `${BASE}/${pkg.id}`, tutor.actor.headers, { levelMax: 8 });

    expect(res.status).toBe(400);
    expect(issuePaths(res.body)).toContain("academicGroups");
  });

  it("re-checks the merged time window", async () => {
    const tutor = await createReadyTutor();
    const pkg = await createTuitionPackage(tutor.tutor.id, { subjectIds: [tutor.subjectId] });

    // The helper's package starts at 10:00, so ending at 09:00 is refused.
    const res = await send("PATCH", `${BASE}/${pkg.id}`, tutor.actor.headers, { timeTo: "09:00" });

    expect(res.status).toBe(400);
    expect(issuePaths(res.body)).toContain("timeTo");
  });

  it("daysPerWeek null clears the count", async () => {
    const tutor = await createReadyTutor();
    const pkg = await createTuitionPackage(tutor.tutor.id, { subjectIds: [tutor.subjectId] });

    const res = await send("PATCH", `${BASE}/${pkg.id}`, tutor.actor.headers, {
      daysPerWeek: null,
    });

    expect(res.status).toBe(200);
    expect(res.body.daysPerWeek).toBeNull();
  });

  it("returns 404 for another tutor's package", async () => {
    const owner = await createReadyTutor();
    const stranger = await createReadyTutor();
    const pkg = await createTuitionPackage(owner.tutor.id, { subjectIds: [owner.subjectId] });

    const res = await send("PATCH", `${BASE}/${pkg.id}`, stranger.actor.headers, {
      price: 17000,
    });

    expect(res.status).toBe(404);
    const row = await prisma.tuitionPackage.findUniqueOrThrow({ where: { id: pkg.id } });
    expect(row.price).toBe(15000);
  });

  it("returns 409 LISTING_NOT_OPEN when the package is CLOSED", async () => {
    const tutor = await createReadyTutor();
    const pkg = await createTuitionPackage(tutor.tutor.id, {
      subjectIds: [tutor.subjectId],
      status: "CLOSED",
    });

    const res = await send("PATCH", `${BASE}/${pkg.id}`, tutor.actor.headers, { price: 17000 });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("LISTING_NOT_OPEN");
  });

  it("returns 400 for an empty body", async () => {
    const tutor = await createReadyTutor();
    const pkg = await createTuitionPackage(tutor.tutor.id, { subjectIds: [tutor.subjectId] });

    const res = await send("PATCH", `${BASE}/${pkg.id}`, tutor.actor.headers, {});

    expect(res.status).toBe(400);
  });

  it("queues one PACKAGE_UPDATED alert for each PENDING or CONFIRMED student, and none for a WITHDRAWN one", async () => {
    const tutor = await createReadyTutor();
    const pkg = await createTuitionPackage(tutor.tutor.id, { subjectIds: [tutor.subjectId] });
    const pending = await createStudent();
    const confirmed = await createStudent();
    const withdrawn = await createStudent();
    const pendingApp = await createApplication({
      packageId: pkg.id,
      tutorId: tutor.tutor.id,
      studentId: pending.student.id,
      initiatedBy: "STUDENT",
    });
    const confirmedApp = await createApplication({
      packageId: pkg.id,
      tutorId: tutor.tutor.id,
      studentId: confirmed.student.id,
      initiatedBy: "STUDENT",
      status: "CONFIRMED",
    });
    await createApplication({
      packageId: pkg.id,
      tutorId: tutor.tutor.id,
      studentId: withdrawn.student.id,
      initiatedBy: "STUDENT",
      status: "WITHDRAWN",
    });

    const res = await send("PATCH", `${BASE}/${pkg.id}`, tutor.actor.headers, { price: 17000 });

    expect(res.status).toBe(200);
    const alerts = await prisma.appNotification.findMany({
      where: { kind: "PACKAGE_UPDATED" },
      select: { recipientId: true, applicationId: true },
    });
    expect(alerts).toHaveLength(2);
    expect(alerts).toEqual(
      expect.arrayContaining([
        { recipientId: pending.student.accountId, applicationId: pendingApp.id },
        { recipientId: confirmed.student.accountId, applicationId: confirmedApp.id },
      ]),
    );
  });
});

describe("POST /packages/:id/close (#56)", () => {
  it("closes the package and returns status CLOSED", async () => {
    const tutor = await createReadyTutor();
    const pkg = await createTuitionPackage(tutor.tutor.id, { subjectIds: [tutor.subjectId] });

    const res = await send("POST", `${BASE}/${pkg.id}/close`, tutor.actor.headers);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: pkg.id, status: "CLOSED" });
    const row = await prisma.tuitionPackage.findUniqueOrThrow({ where: { id: pkg.id } });
    expect(row.status).toBe("CLOSED");
  });

  it("expires the PENDING request and alerts that student, and leaves a CONFIRMED request on another package untouched", async () => {
    const tutor = await createReadyTutor();
    const pkg = await createTuitionPackage(tutor.tutor.id, { subjectIds: [tutor.subjectId] });
    const otherPkg = await createTuitionPackage(tutor.tutor.id, {
      subjectIds: [tutor.subjectId],
    });
    const pendingStudent = await createStudent();
    const confirmedStudent = await createStudent();
    const pendingApp = await createApplication({
      packageId: pkg.id,
      tutorId: tutor.tutor.id,
      studentId: pendingStudent.student.id,
      initiatedBy: "STUDENT",
    });
    const confirmedApp = await createApplication({
      packageId: otherPkg.id,
      tutorId: tutor.tutor.id,
      studentId: confirmedStudent.student.id,
      initiatedBy: "STUDENT",
      status: "CONFIRMED",
    });

    const res = await send("POST", `${BASE}/${pkg.id}/close`, tutor.actor.headers);

    expect(res.status).toBe(200);
    expect(
      (await prisma.application.findUniqueOrThrow({ where: { id: pendingApp.id } })).status,
    ).toBe("EXPIRED");
    const confirmedAfter = await prisma.application.findUniqueOrThrow({
      where: { id: confirmedApp.id },
    });
    expect(confirmedAfter.status).toBe("CONFIRMED");
    expect(confirmedAfter.confirmedAt).toEqual(confirmedApp.confirmedAt);

    const alerts = await prisma.appNotification.findMany({
      where: { kind: "PACKAGE_CLOSED" },
      select: { recipientId: true, applicationId: true },
    });
    expect(alerts).toEqual([
      { recipientId: pendingStudent.student.accountId, applicationId: pendingApp.id },
    ]);
  });

  it("returns 409 LISTING_NOT_OPEN on a second close", async () => {
    const tutor = await createReadyTutor();
    const pkg = await createTuitionPackage(tutor.tutor.id, { subjectIds: [tutor.subjectId] });
    const first = await send("POST", `${BASE}/${pkg.id}/close`, tutor.actor.headers);
    expect(first.status).toBe(200);

    const second = await send("POST", `${BASE}/${pkg.id}/close`, tutor.actor.headers);

    expect(second.status).toBe(409);
    expect(second.body.code).toBe("LISTING_NOT_OPEN");
  });

  it("returns 404 for another tutor's package", async () => {
    const owner = await createReadyTutor();
    const stranger = await createReadyTutor();
    const pkg = await createTuitionPackage(owner.tutor.id, { subjectIds: [owner.subjectId] });

    const res = await send("POST", `${BASE}/${pkg.id}/close`, stranger.actor.headers);

    expect(res.status).toBe(404);
    const row = await prisma.tuitionPackage.findUniqueOrThrow({ where: { id: pkg.id } });
    expect(row.status).toBe("OPEN");
  });

  it("a student cannot request the package after it is closed (409 LISTING_NOT_OPEN)", async () => {
    const tutor = await createReadyTutor();
    const pkg = await createTuitionPackage(tutor.tutor.id, { subjectIds: [tutor.subjectId] });
    const closed = await send("POST", `${BASE}/${pkg.id}/close`, tutor.actor.headers);
    expect(closed.status).toBe(200);
    const student = await createStudent();

    const res = await send("POST", `${BASE}/${pkg.id}/applications`, student.actor.headers);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("LISTING_NOT_OPEN");
    expect(await prisma.application.count({ where: { packageId: pkg.id } })).toBe(0);
  });
});

describe("phone verification in package readiness", () => {
  it("refuses a new package with the tutor switch on and the phone unverified", async () => {
    const tutor = await createReadyTutor();
    await setPlatformSetting("require_tutor_phone_verification", true);

    const res = await send("POST", `${BASE}`, tutor.actor.headers, packageBody(tutor.subjectId));

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("PROFILE_INCOMPLETE");
    expect(res.body.details.missing).toContain("phone_verification");
    expect(await prisma.tuitionPackage.count({ where: { tutorId: tutor.tutor.id } })).toBe(0);
  });
});

describe("resubmitting a rejected package", () => {
  async function rejectedPackage() {
    const tutor = await createReadyTutor();
    const pkg = await createTuitionPackage(tutor.tutor.id, {
      subjectIds: [tutor.subjectId],
      moderationStatus: "REJECTED",
      moderationNote: "Price is unclear",
    });
    return { tutor, pkg };
  }

  it("refuses a resubmit with the tutor switch on and the phone unverified, and leaves the package rejected", async () => {
    const { tutor, pkg } = await rejectedPackage();
    await setPlatformSetting("require_tutor_phone_verification", true);

    const res = await send("PATCH", `${BASE}/${pkg.id}`, tutor.actor.headers, {
      title: "Weekend Physics",
    });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("PROFILE_INCOMPLETE");
    expect(res.body.details.missing).toContain("phone_verification");
    const row = await prisma.tuitionPackage.findUniqueOrThrow({ where: { id: pkg.id } });
    expect(row.moderationStatus).toBe("REJECTED");
    expect(row.moderationNote).toBe("Price is unclear");
    expect(row.title).toBe("SSC Math Booster");
  });

  it("resubmits once the tutor phone is verified", async () => {
    const { tutor, pkg } = await rejectedPackage();
    await setPlatformSetting("require_tutor_phone_verification", true);
    await prisma.tutor.update({
      where: { id: tutor.tutor.id },
      data: { phoneVerifiedAt: new Date() },
    });

    const res = await send("PATCH", `${BASE}/${pkg.id}`, tutor.actor.headers, {
      title: "Weekend Physics",
    });

    expect(res.status).toBe(200);
    expect(res.body.moderationStatus).toBe("PENDING");
  });

  it("resubmits with the tutor switch off and the phone unverified", async () => {
    const { tutor, pkg } = await rejectedPackage();
    await setPlatformSetting("require_tutor_phone_verification", false);

    const res = await send("PATCH", `${BASE}/${pkg.id}`, tutor.actor.headers, {
      title: "Weekend Physics",
    });

    expect(res.status).toBe(200);
    expect(res.body.moderationStatus).toBe("PENDING");
  });

  it("edits an approved package while the phone is unverified, since only resubmits are gated", async () => {
    const tutor = await createReadyTutor();
    const pkg = await createTuitionPackage(tutor.tutor.id, {
      subjectIds: [tutor.subjectId],
      moderationStatus: "APPROVED",
    });
    await setPlatformSetting("require_tutor_phone_verification", true);

    const res = await send("PATCH", `${BASE}/${pkg.id}`, tutor.actor.headers, {
      title: "Weekend Physics",
    });

    expect(res.status).toBe(200);
    expect(res.body.moderationStatus).toBe("APPROVED");
  });
});
