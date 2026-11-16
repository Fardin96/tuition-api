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
  createTutorZone,
  getAuthHeaders,
  setStudentLocation,
  setTutorLocation,
} from "../../tests/helpers.js";

const BASE = "/api/v1/requirements";

// Default pins used by the helpers. A point 0.02 degrees north is about 2.2 km away.
const TUTOR_LAT = 23.8103;
const TUTOR_LNG = 90.4125;
const FAR = { lat: 23.95, lng: 90.4125 }; // about 16 km north, outside a 5 km zone

async function createBrowsingTutor({ pin = true }: { pin?: boolean } = {}) {
  const account = await createAccount({ role: "TUTOR" });
  const tutor = await createTutorProfile(account.id);
  if (pin) await setTutorLocation(tutor.id, { lat: TUTOR_LAT, lng: TUTOR_LNG });
  return { tutor, headers: await getAuthHeaders(account) };
}

async function createStudentAt(
  options: {
    areaId?: number;
    pin?: { lat: number; lng: number; needsReaddress?: boolean } | null;
    status?: "ACTIVE" | "BLOCKED";
  } = {},
) {
  const area = options.areaId ?? (await createArea()).id;
  const account = await createAccount({ role: "STUDENT", status: options.status });
  const student = await createStudentProfile(account.id, area);
  if (options.pin) await setStudentLocation(student.id, options.pin);
  return { student, areaId: area, headers: await getAuthHeaders(account) };
}

async function browse(
  headers: Record<string, string>,
  query: Record<string, string | number> = {},
) {
  const search = new URLSearchParams(
    Object.entries(query).map(([k, v]) => [k, String(v)]),
  ).toString();
  const app = await createTestApp();
  const res = await app.inject({
    method: "GET",
    url: search ? `${BASE}?${search}` : BASE,
    headers,
  });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

function idsOf(body: { requirements: { id: string }[] }) {
  return body.requirements.map((r) => r.id);
}

describe("GET /requirements (tutor browse, #46)", () => {
  it("is limited to tutors", async () => {
    const { headers } = await createStudentAt();
    const res = await browse(headers);
    expect(res.status).toBe(403);
  });

  it("scope=nearby lists a requirement whose student pin is inside a tutor zone, and hides one outside it", async () => {
    const { tutor, headers } = await createBrowsingTutor();
    await createTutorZone(tutor.id, { radiusM: 5000 });
    const inside = await createStudentAt({ pin: { lat: TUTOR_LAT, lng: TUTOR_LNG } });
    const insideReq = await createRequirement({ studentId: inside.student.id });
    const outside = await createStudentAt({ pin: FAR });
    const outsideReq = await createRequirement({ studentId: outside.student.id });

    const nearby = await browse(headers, { scope: "nearby" });
    expect(nearby.status).toBe(200);
    expect(idsOf(nearby.body)).toContain(insideReq.id);
    expect(idsOf(nearby.body)).not.toContain(outsideReq.id);
    expect(nearby.body.noServiceArea).toBe(false);

    const all = await browse(headers, { scope: "all" });
    expect(idsOf(all.body)).toEqual(expect.arrayContaining([insideReq.id, outsideReq.id]));
  });

  it("defaults to scope=nearby", async () => {
    const { headers } = await createBrowsingTutor();
    const { student } = await createStudentAt({ pin: FAR });
    const req = await createRequirement({ studentId: student.id });

    const res = await browse(headers);
    expect(idsOf(res.body)).not.toContain(req.id);
  });

  it("does not match a student pin flagged needs_readdress, even inside a zone", async () => {
    const { tutor, headers } = await createBrowsingTutor();
    await createTutorZone(tutor.id, { radiusM: 5000 });
    const stale = await createStudentAt({
      pin: { lat: TUTOR_LAT, lng: TUTOR_LNG, needsReaddress: true },
    });
    const req = await createRequirement({ studentId: stale.student.id });

    const nearby = await browse(headers, { scope: "nearby" });
    expect(idsOf(nearby.body)).not.toContain(req.id);
  });

  it("area fallback: a requirement in one of the tutor's areas is listed nearby even when the pin is far", async () => {
    const { tutor, headers } = await createBrowsingTutor();
    const served = await createArea();
    const other = await createArea();
    await prisma.tutorArea.create({ data: { tutorId: tutor.id, areaId: served.id } });
    const farStudent = await createStudentAt({ areaId: served.id, pin: FAR });
    const inArea = await createRequirement({ studentId: farStudent.student.id, areaId: served.id });
    const elsewhere = await createStudentAt({ areaId: other.id, pin: FAR });
    const notServed = await createRequirement({
      studentId: elsewhere.student.id,
      areaId: other.id,
    });

    const nearby = await browse(headers, { scope: "nearby" });
    expect(idsOf(nearby.body)).toContain(inArea.id);
    expect(idsOf(nearby.body)).not.toContain(notServed.id);
    expect(nearby.body.noServiceArea).toBe(false);
  });

  it("distanceKm is the pin distance rounded to the nearest 0.5 km, and null without a tutor pin", async () => {
    const { tutor, headers } = await createBrowsingTutor();
    await createTutorZone(tutor.id, { radiusM: 5000 });
    // 0.0042, 0.009 and 0.0171 degrees north are about 0.47, 1.0 and 1.9 km.
    const near = await createStudentAt({ pin: { lat: TUTOR_LAT + 0.0042, lng: TUTOR_LNG } });
    const mid = await createStudentAt({ pin: { lat: TUTOR_LAT + 0.009, lng: TUTOR_LNG } });
    const far = await createStudentAt({ pin: { lat: TUTOR_LAT + 0.0171, lng: TUTOR_LNG } });
    const nearReq = await createRequirement({ studentId: near.student.id });
    const midReq = await createRequirement({ studentId: mid.student.id });
    const farReq = await createRequirement({ studentId: far.student.id });

    const res = await browse(headers, { scope: "nearby" });
    const distance = (id: string) => res.body.requirements.find((r: { id: string }) => r.id === id);
    expect(distance(nearReq.id).distanceKm).toBe(0.5);
    expect(distance(midReq.id).distanceKm).toBe(1);
    expect(distance(farReq.id).distanceKm).toBe(2);

    // A tutor without a pin sees null, not 0. The area fallback still lists the requirement.
    const { tutor: noPin, headers: noPinHeaders } = await createBrowsingTutor({ pin: false });
    const area = await createArea();
    await prisma.tutorArea.create({ data: { tutorId: noPin.id, areaId: area.id } });
    const local = await createStudentAt({ areaId: area.id, pin: FAR });
    const localReq = await createRequirement({ studentId: local.student.id, areaId: area.id });

    const noPinRes = await browse(noPinHeaders, { scope: "nearby" });
    const row = noPinRes.body.requirements.find((r: { id: string }) => r.id === localReq.id);
    expect(row.distanceKm).toBeNull();
  });

  it("sets closed when another tutor's application is CONFIRMED and myApplication for the caller's own application", async () => {
    const { tutor, headers } = await createBrowsingTutor();
    const area = await createArea();
    await prisma.tutorArea.create({ data: { tutorId: tutor.id, areaId: area.id } });
    const { student } = await createStudentAt({ areaId: area.id, pin: FAR });

    const mine = await createRequirement({ studentId: student.id, areaId: area.id });
    const myApplication = await createApplication({
      requirementId: mine.id,
      tutorId: tutor.id,
      studentId: student.id,
      initiatedBy: "TUTOR",
    });

    const taken = await createRequirement({ studentId: student.id, areaId: area.id });
    const { tutor: winner } = await createBrowsingTutor();
    await createApplication({
      requirementId: taken.id,
      tutorId: winner.id,
      studentId: student.id,
      initiatedBy: "TUTOR",
      status: "CONFIRMED",
    });

    const res = await browse(headers, { scope: "nearby" });
    const byId = (id: string) => res.body.requirements.find((r: { id: string }) => r.id === id);
    expect(byId(mine.id)).toMatchObject({
      closed: false,
      myApplication: { id: myApplication.id, status: "PENDING" },
    });
    expect(byId(taken.id)).toMatchObject({ closed: true, myApplication: null });
  });

  it("myApplication stays null for another tutor's application", async () => {
    const area = await createArea();
    const { tutor: rival } = await createBrowsingTutor();
    const { student } = await createStudentAt({ areaId: area.id, pin: FAR });
    const req = await createRequirement({ studentId: student.id, areaId: area.id });
    await createApplication({
      requirementId: req.id,
      tutorId: rival.id,
      studentId: student.id,
      initiatedBy: "TUTOR",
    });
    const { tutor: me, headers: meHeaders } = await createBrowsingTutor();
    await prisma.tutorArea.create({ data: { tutorId: me.id, areaId: area.id } });

    const res = await browse(meHeaders, { scope: "all" });
    expect(res.body.requirements.find((r: { id: string }) => r.id === req.id)).toMatchObject({
      closed: false,
      myApplication: null,
    });
  });

  it("reports noServiceArea only when the tutor has neither zones nor areas", async () => {
    const bare = await createBrowsingTutor();
    expect((await browse(bare.headers)).body.noServiceArea).toBe(true);

    const zoned = await createBrowsingTutor();
    await createTutorZone(zoned.tutor.id);
    expect((await browse(zoned.headers)).body.noServiceArea).toBe(false);

    const withArea = await createBrowsingTutor();
    const area = await createArea();
    await prisma.tutorArea.create({ data: { tutorId: withArea.tutor.id, areaId: area.id } });
    expect((await browse(withArea.headers)).body.noServiceArea).toBe(false);
  });

  it("filters by subjectId, areaId, levelCode and curriculum", async () => {
    const { headers } = await createBrowsingTutor();
    const math = await createSubject();
    const english = await createSubject();
    const area = await createArea();
    const other = await createArea();
    const { student } = await createStudentAt({ areaId: area.id, pin: FAR });

    const mathReq = await createRequirement({
      studentId: student.id,
      areaId: area.id,
      subjectIds: [math.id],
      levelCode: 10,
      curriculum: "BANGLA_MEDIUM",
    });
    const englishReq = await createRequirement({
      studentId: student.id,
      areaId: other.id,
      subjectIds: [english.id],
      levelCode: 8,
      curriculum: "ENGLISH_VERSION",
    });

    const bySubject = await browse(headers, { scope: "all", subjectId: math.id });
    expect(idsOf(bySubject.body)).toEqual([mathReq.id]);

    const byArea = await browse(headers, { scope: "all", areaId: other.id });
    expect(idsOf(byArea.body)).toEqual([englishReq.id]);

    const byLevel = await browse(headers, { scope: "all", levelCode: 8 });
    expect(idsOf(byLevel.body)).toEqual([englishReq.id]);

    const byCurriculum = await browse(headers, { scope: "all", curriculum: "BANGLA_MEDIUM" });
    expect(idsOf(byCurriculum.body)).toEqual([mathReq.id]);
  });

  it("pages newest first with a keyset cursor", async () => {
    const { headers } = await createBrowsingTutor();
    const { student } = await createStudentAt({ pin: FAR });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const req = await createRequirement({ studentId: student.id });
      await prisma.tuitionRequirement.update({
        where: { id: req.id },
        data: { createdAt: new Date(Date.UTC(2026, 0, 1 + i)) },
      });
      ids.push(req.id);
    }
    const newestFirst = [...ids].reverse();

    const first = await browse(headers, { scope: "all", limit: 2 });
    expect(idsOf(first.body)).toEqual(newestFirst.slice(0, 2));
    expect(first.body.nextCursor).toEqual(expect.any(String));

    const second = await browse(headers, {
      scope: "all",
      limit: 2,
      cursor: first.body.nextCursor,
    });
    expect(idsOf(second.body)).toEqual([newestFirst[2]]);
    expect(second.body.nextCursor).toBeNull();
  });

  it("lists only OPEN requirements from ACTIVE students", async () => {
    const { headers } = await createBrowsingTutor();
    const { student } = await createStudentAt({ pin: FAR });
    const open = await createRequirement({ studentId: student.id });
    const closed = await createRequirement({ studentId: student.id, status: "CLOSED" });
    const draft = await createRequirement({ studentId: student.id, status: "DRAFT" });
    const blocked = await createStudentAt({ pin: FAR, status: "BLOCKED" });
    const blockedReq = await createRequirement({ studentId: blocked.student.id });

    const res = await browse(headers, { scope: "all" });
    expect(idsOf(res.body)).toEqual([open.id]);
    expect(idsOf(res.body)).not.toContain(closed.id);
    expect(idsOf(res.body)).not.toContain(draft.id);
    expect(idsOf(res.body)).not.toContain(blockedReq.id);
  });
});
