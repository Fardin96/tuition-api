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
  createTutorZone,
  getAuthHeaders,
  setStudentLocation,
} from "../../tests/helpers.js";

const BASE = "/api/v1/packages";

// Default pins. The student pin sits inside a zone centred on the same point.
const CENTRE = { lat: 23.8103, lng: 90.4125 };
const FAR = { lat: 23.95, lng: 90.4125 }; // about 16 km north, outside a 5 km zone

async function createListedTutor({ listed = true }: { listed?: boolean } = {}) {
  const account = await createAccount({ role: "TUTOR" });
  const tutor = await createTutorProfile(account.id, { isListed: listed });
  return { tutor, headers: await getAuthHeaders(account) };
}

async function createStudentAt(
  options: {
    areaId?: number;
    pin?: { lat: number; lng: number; needsReaddress?: boolean } | null;
  } = {},
) {
  const area = options.areaId ?? (await createArea()).id;
  const account = await createAccount({ role: "STUDENT" });
  const student = await createStudentProfile(account.id, area);
  if (options.pin) await setStudentLocation(student.id, options.pin);
  return { student, areaId: area, headers: await getAuthHeaders(account) };
}

async function createPackage(
  tutorId: string,
  overrides: {
    areaId?: number | null;
    status?: "OPEN" | "CLOSED" | "FILLED" | "EXPIRED" | "DRAFT";
    moderationStatus?: "PENDING" | "APPROVED" | "REJECTED";
    subjectId?: number;
    levelCode?: number;
    curriculum?: "BANGLA_MEDIUM" | "ENGLISH_VERSION";
  } = {},
) {
  const pkg = await createTuitionPackage(tutorId, {
    subjectId: overrides.subjectId,
    levelCode: overrides.levelCode,
    curriculum: overrides.curriculum,
    status: overrides.status,
  });
  if (overrides.areaId !== undefined || overrides.moderationStatus !== undefined) {
    return prisma.tuitionPackage.update({
      where: { id: pkg.id },
      data: {
        ...(overrides.areaId !== undefined ? { areaId: overrides.areaId } : {}),
        ...(overrides.moderationStatus ? { moderationStatus: overrides.moderationStatus } : {}),
      },
    });
  }
  return pkg;
}

async function browse(headers: Record<string, string>, query: Record<string, string> = {}) {
  const app = await createTestApp();
  const search = new URLSearchParams(query).toString();
  const res = await app.inject({
    method: "GET",
    url: search ? `${BASE}?${search}` : `${BASE}/`,
    headers,
  });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

function idsOf(body: { packages: { id: string }[] }) {
  return body.packages.map((p) => p.id);
}

describe("GET /packages (student browse, #52)", () => {
  it("is limited to students", async () => {
    const { headers } = await createListedTutor();
    const res = await browse(headers);
    expect(res.status).toBe(403);
  });

  it("nearby always lists an online package, even without a student pin", async () => {
    const { tutor } = await createListedTutor();
    const online = await createPackage(tutor.id, { areaId: null });
    const { headers } = await createStudentAt();

    const res = await browse(headers, { scope: "nearby" });

    expect(res.status).toBe(200);
    expect(idsOf(res.body)).toContain(online.id);
    expect(res.body.locationMissing).toBe(true);
  });

  it("nearby lists an area package whose tutor has a zone covering the student pin, and hides one that does not", async () => {
    const { tutor } = await createListedTutor();
    await createTutorZone(tutor.id, { radiusM: 5000, ...CENTRE });
    const area = await createArea();
    const covered = await createPackage(tutor.id, { areaId: area.id });
    const { headers } = await createStudentAt({ areaId: area.id, pin: CENTRE });

    const { tutor: remote } = await createListedTutor();
    await createTutorZone(remote.id, { radiusM: 5000, ...FAR });
    const uncovered = await createPackage(remote.id, { areaId: area.id });

    const nearby = await browse(headers, { scope: "nearby" });
    expect(nearby.body.locationMissing).toBe(false);
    expect(idsOf(nearby.body)).toContain(covered.id);
    expect(idsOf(nearby.body)).not.toContain(uncovered.id);

    const all = await browse(headers, { scope: "all" });
    expect(idsOf(all.body)).toEqual(expect.arrayContaining([covered.id, uncovered.id]));
  });

  it("without a usable pin, nearby falls back to online packages and the student's own area, with locationMissing true", async () => {
    const { tutor } = await createListedTutor();
    const home = await createArea();
    const elsewhere = await createArea();
    const inArea = await createPackage(tutor.id, { areaId: home.id });
    const outOfArea = await createPackage(tutor.id, { areaId: elsewhere.id });
    const online = await createPackage(tutor.id, { areaId: null });
    const { headers } = await createStudentAt({ areaId: home.id });

    const res = await browse(headers, { scope: "nearby" });

    expect(res.body.locationMissing).toBe(true);
    expect(idsOf(res.body)).toEqual(expect.arrayContaining([inArea.id, online.id]));
    expect(idsOf(res.body)).not.toContain(outOfArea.id);
  });

  it("treats a needs_readdress pin as missing, so the zone match is skipped", async () => {
    const { tutor } = await createListedTutor();
    await createTutorZone(tutor.id, { radiusM: 5000, ...CENTRE });
    const zoneArea = await createArea();
    const zoned = await createPackage(tutor.id, { areaId: zoneArea.id });
    const home = await createArea();
    const { headers } = await createStudentAt({
      areaId: home.id,
      pin: { ...CENTRE, needsReaddress: true },
    });

    const res = await browse(headers, { scope: "nearby" });

    expect(res.body.locationMissing).toBe(true);
    expect(idsOf(res.body)).not.toContain(zoned.id);
  });

  it("lists only APPROVED, OPEN packages from listed tutors", async () => {
    const { tutor } = await createListedTutor();
    const good = await createPackage(tutor.id, { areaId: null });
    const pending = await createPackage(tutor.id, { areaId: null, moderationStatus: "PENDING" });
    const rejected = await createPackage(tutor.id, { areaId: null, moderationStatus: "REJECTED" });
    const closed = await createPackage(tutor.id, { areaId: null, status: "CLOSED" });
    const { tutor: unlisted } = await createListedTutor({ listed: false });
    const hidden = await createPackage(unlisted.id, { areaId: null });
    const { headers } = await createStudentAt();

    const res = await browse(headers, { scope: "all" });

    expect(idsOf(res.body)).toEqual([good.id]);
    for (const id of [pending.id, rejected.id, closed.id, hidden.id]) {
      expect(idsOf(res.body)).not.toContain(id);
    }
  });

  it("filters by subjectId, levelCode and curriculum", async () => {
    const { tutor } = await createListedTutor();
    const math = await createSubject();
    const english = await createSubject();
    const mathPkg = await createPackage(tutor.id, {
      areaId: null,
      subjectId: math.id,
      levelCode: 10,
      curriculum: "BANGLA_MEDIUM",
    });
    const englishPkg = await createPackage(tutor.id, {
      areaId: null,
      subjectId: english.id,
      levelCode: 8,
      curriculum: "ENGLISH_VERSION",
    });
    const { headers } = await createStudentAt();

    expect(
      idsOf((await browse(headers, { scope: "all", subjectId: String(math.id) })).body),
    ).toEqual([mathPkg.id]);
    expect(idsOf((await browse(headers, { scope: "all", levelCode: "8" })).body)).toEqual([
      englishPkg.id,
    ]);
    expect(
      idsOf((await browse(headers, { scope: "all", curriculum: "BANGLA_MEDIUM" })).body),
    ).toEqual([mathPkg.id]);
  });

  it("pages newest first with a keyset cursor", async () => {
    const { tutor } = await createListedTutor();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const pkg = await createPackage(tutor.id, { areaId: null });
      await prisma.tuitionPackage.update({
        where: { id: pkg.id },
        data: { createdAt: new Date(Date.UTC(2026, 0, 1 + i)) },
      });
      ids.push(pkg.id);
    }
    const newestFirst = [...ids].reverse();
    const { headers } = await createStudentAt();

    const first = await browse(headers, { scope: "all", limit: "2" });
    expect(idsOf(first.body)).toEqual(newestFirst.slice(0, 2));
    expect(first.body.nextCursor).toEqual(expect.any(String));

    const second = await browse(headers, {
      scope: "all",
      limit: "2",
      cursor: first.body.nextCursor,
    });
    expect(idsOf(second.body)).toEqual([newestFirst[2]]);
    expect(second.body.nextCursor).toBeNull();
  });

  it("marks closed packages and myApplication for the calling student only", async () => {
    const { tutor } = await createListedTutor();
    const requested = await createPackage(tutor.id, { areaId: null });
    const taken = await createPackage(tutor.id, { areaId: null });
    const student = await createStudentAt();
    const rival = await createStudentAt();

    const mine = await createApplication({
      packageId: requested.id,
      tutorId: tutor.id,
      studentId: student.student.id,
      initiatedBy: "STUDENT",
    });
    await createApplication({
      packageId: taken.id,
      tutorId: tutor.id,
      studentId: rival.student.id,
      initiatedBy: "STUDENT",
      status: "CONFIRMED",
    });

    const res = await browse(student.headers, { scope: "all" });
    const byId = (id: string) => res.body.packages.find((p: { id: string }) => p.id === id);
    expect(byId(requested.id)).toMatchObject({
      closed: false,
      myApplication: { id: mine.id, status: "PENDING" },
    });
    expect(byId(taken.id)).toMatchObject({ closed: true, myApplication: null });
  });
});

describe("GET /packages/:id (#54)", () => {
  it("a student sees an APPROVED package and gets 404 for one that is not approved", async () => {
    const app = await createTestApp();
    const { tutor } = await createListedTutor();
    const approved = await createPackage(tutor.id, { areaId: null });
    const pending = await createPackage(tutor.id, { areaId: null, moderationStatus: "PENDING" });
    const { headers } = await createStudentAt();

    const ok = await app.inject({ method: "GET", url: `${BASE}/${approved.id}`, headers });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body)).toMatchObject({
      id: approved.id,
      closed: false,
      myApplication: null,
      tutor: { id: tutor.id },
    });

    const hidden = await app.inject({ method: "GET", url: `${BASE}/${pending.id}`, headers });
    expect(hidden.statusCode).toBe(404);
  });

  it("a student gets 404 for an APPROVED package whose tutor is not listed, and the owner still sees it", async () => {
    const app = await createTestApp();
    const { tutor, headers: ownerHeaders } = await createListedTutor({ listed: false });
    const pkg = await createPackage(tutor.id, { areaId: null });
    const { headers } = await createStudentAt();

    const hidden = await app.inject({ method: "GET", url: `${BASE}/${pkg.id}`, headers });
    expect(hidden.statusCode).toBe(404);
    expect(JSON.parse(hidden.body).message).toBe("Package not found");

    const owner = await app.inject({
      method: "GET",
      url: `${BASE}/${pkg.id}`,
      headers: ownerHeaders,
    });
    expect(owner.statusCode).toBe(200);
  });

  it("another tutor gets 404, while the owning tutor sees its own pending package", async () => {
    const app = await createTestApp();
    const { tutor, headers: ownerHeaders } = await createListedTutor();
    const pending = await createPackage(tutor.id, { areaId: null, moderationStatus: "PENDING" });
    const { headers: otherHeaders } = await createListedTutor();

    const stranger = await app.inject({
      method: "GET",
      url: `${BASE}/${pending.id}`,
      headers: otherHeaders,
    });
    expect(stranger.statusCode).toBe(404);

    const owner = await app.inject({
      method: "GET",
      url: `${BASE}/${pending.id}`,
      headers: ownerHeaders,
    });
    expect(owner.statusCode).toBe(200);
    expect(JSON.parse(owner.body)).toMatchObject({
      id: pending.id,
      moderationStatus: "PENDING",
      myApplication: null,
    });
  });

  it("the calling student's own application is shown on the detail", async () => {
    const app = await createTestApp();
    const { tutor } = await createListedTutor();
    const pkg = await createPackage(tutor.id, { areaId: null });
    const student = await createStudentAt();
    const mine = await createApplication({
      packageId: pkg.id,
      tutorId: tutor.id,
      studentId: student.student.id,
      initiatedBy: "STUDENT",
    });

    const res = await app.inject({
      method: "GET",
      url: `${BASE}/${pkg.id}`,
      headers: student.headers,
    });

    expect(JSON.parse(res.body).myApplication).toEqual({ id: mine.id, status: "PENDING" });
  });

  it("returns 404 for an unknown package id", async () => {
    const app = await createTestApp();
    const { headers } = await createStudentAt();
    const res = await app.inject({
      method: "GET",
      url: `${BASE}/00000000-0000-4000-8000-000000000000`,
      headers,
    });
    expect(res.statusCode).toBe(404);
  });
});
