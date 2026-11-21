import { randomUUID } from "node:crypto";
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

// Default pins used by the helpers. A point 0.02 degrees north is about 2.2 km away.
const TUTOR_LAT = 23.8103;
const TUTOR_LNG = 90.4125;
const FAR = { lat: 23.95, lng: 90.4125 }; // about 16 km north, outside a 5 km zone
const TUTOR_PIN = { lat: TUTOR_LAT, lng: TUTOR_LNG };

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

// A requirement whose student pins at `pin` (or has no pin when null).
async function requirementAt(
  pin: { lat: number; lng: number } | null,
  data: {
    subjectIds: number[];
    levelCode?: number;
    curriculum?: "BANGLA_MEDIUM" | "ENGLISH_VERSION";
    areaId?: number;
    tuitionType?: string;
  },
) {
  const { student } = await createStudentAt({ pin, areaId: data.areaId });
  return createRequirement({ studentId: student.id, ...data });
}

// Inside Dhaka city, about 8 km south of TUTOR_PIN (outside a 2 km zone around it).
const SOUTH_IN_CITY = { lat: 23.7383, lng: 90.4125 };

// A set of the tutor's own. The subjects must be on the tutor's profile first (composite FK).
// teachesOnline is not a factory option, so it is set after the row exists.
async function createSet(
  tutorId: string,
  subjectIds: number[],
  overrides: Parameters<typeof createTutorRequirement>[1] & { teachesOnline?: boolean } = {},
) {
  const { teachesOnline, ...factory } = overrides;
  await prisma.tutorSubject.createMany({
    data: subjectIds.map((subjectId) => ({ tutorId, subjectId })),
    skipDuplicates: true,
  });
  const set = await createTutorRequirement(tutorId, { subjectIds, ...factory });
  if (teachesOnline === undefined) return set;
  return prisma.tutorRequirement.update({ where: { id: set.id }, data: { teachesOnline } });
}

function matchOf(body: { requirements: { id: string; match: unknown }[] }, id: string) {
  return body.requirements.find((r) => r.id === id)?.match;
}

describe("GET /requirements scope=set (tutor requirement sets)", () => {
  it("lists only requirements the set covers by curriculum, level, subject and zone", async () => {
    const { tutor, headers } = await createBrowsingTutor();
    const zoneId = await createTutorZone(tutor.id, { radiusM: 5000 });
    const math = await createSubject();
    const english = await createSubject();
    const set = await createSet(tutor.id, [math.id], {
      isDefault: true,
      zoneIds: [zoneId],
      curricula: ["BANGLA_MEDIUM"],
      levelMin: 6,
      levelMax: 10,
    });

    const match = await requirementAt(TUTOR_PIN, {
      subjectIds: [math.id],
      levelCode: 8,
      curriculum: "BANGLA_MEDIUM",
    });
    const wrongCurriculum = await requirementAt(TUTOR_PIN, {
      subjectIds: [math.id],
      levelCode: 8,
      curriculum: "ENGLISH_VERSION",
    });
    const wrongLevel = await requirementAt(TUTOR_PIN, {
      subjectIds: [math.id],
      levelCode: 12,
      curriculum: "BANGLA_MEDIUM",
    });
    const wrongSubject = await requirementAt(TUTOR_PIN, {
      subjectIds: [english.id],
      levelCode: 8,
      curriculum: "BANGLA_MEDIUM",
    });
    const outsideZone = await requirementAt(FAR, {
      subjectIds: [math.id],
      levelCode: 8,
      curriculum: "BANGLA_MEDIUM",
    });

    const res = await browse(headers, { scope: "set", setId: set.id });
    expect(res.status).toBe(200);
    expect(idsOf(res.body)).toEqual([match.id]);
    for (const hidden of [wrongCurriculum, wrongLevel, wrongSubject, outsideZone]) {
      expect(idsOf(res.body)).not.toContain(hidden.id);
    }
  });

  it("ignores the manual filters in set mode", async () => {
    const { tutor, headers } = await createBrowsingTutor();
    const zoneId = await createTutorZone(tutor.id, { radiusM: 5000 });
    const math = await createSubject();
    const english = await createSubject();
    const set = await createSet(tutor.id, [math.id], {
      zoneIds: [zoneId],
      curricula: ["BANGLA_MEDIUM"],
      levelMin: 6,
      levelMax: 10,
    });
    const match = await requirementAt(TUTOR_PIN, {
      subjectIds: [math.id],
      levelCode: 8,
      curriculum: "BANGLA_MEDIUM",
    });
    const otherArea = await createArea();

    const res = await browse(headers, {
      scope: "set",
      setId: set.id,
      curriculum: "ENGLISH_VERSION",
      levelCode: 12,
      subjectId: english.id,
      areaId: otherArea.id,
    });
    expect(idsOf(res.body)).toEqual([match.id]);
  });

  it("a set without zones that is not online-only: a pin is matched by the tutor's zones, no pin by the tutor's areas", async () => {
    const { tutor, headers } = await createBrowsingTutor();
    await createTutorZone(tutor.id, { radiusM: 5000 });
    const served = await createArea();
    await prisma.tutorArea.create({ data: { tutorId: tutor.id, areaId: served.id } });
    const math = await createSubject();
    // Without zones, a set that teaches online is online-only and never reaches home tuition.
    const set = await createSet(tutor.id, [math.id], { isDefault: true, teachesOnline: false });

    const inZone = await requirementAt(TUTOR_PIN, { subjectIds: [math.id] });
    const inArea = await requirementAt(null, { subjectIds: [math.id], areaId: served.id });
    const elsewhere = await requirementAt(FAR, { subjectIds: [math.id] });

    const res = await browse(headers, { scope: "set", setId: set.id });
    expect(res.status).toBe(200);
    expect(idsOf(res.body)).toEqual(expect.arrayContaining([inZone.id, inArea.id]));
    expect(idsOf(res.body)).not.toContain(elsewhere.id);
  });

  it("a set without zones that teaches online is online-only: it lists no home tuition", async () => {
    const { tutor, headers } = await createBrowsingTutor();
    await createTutorZone(tutor.id, { radiusM: 5000 });
    const math = await createSubject();
    const set = await createSet(tutor.id, [math.id], { isDefault: true, teachesOnline: true });
    const home = await requirementAt(TUTOR_PIN, { subjectIds: [math.id] });

    const res = await browse(headers, { scope: "set", setId: set.id });
    expect(idsOf(res.body)).not.toContain(home.id);
  });

  it("location is ranked, not required: a pin inside the city but outside the set's zones still matches", async () => {
    const { tutor, headers } = await createBrowsingTutor();
    const zoneId = await createTutorZone(tutor.id, { radiusM: 2000 });
    const math = await createSubject();
    const set = await createSet(tutor.id, [math.id], { isDefault: true, zoneIds: [zoneId] });
    const outsideZone = await requirementAt(SOUTH_IN_CITY, { subjectIds: [math.id] });

    const res = await browse(headers, { scope: "set", setId: set.id });
    expect(idsOf(res.body)).toEqual([outsideZone.id]);
  });

  it("a pin outside the city matches only with a zone or home within 2 km of it", async () => {
    const { tutor, headers } = await createBrowsingTutor();
    const zoneId = await createTutorZone(tutor.id, { radiusM: 5000 });
    const math = await createSubject();
    const set = await createSet(tutor.id, [math.id], { isDefault: true, zoneIds: [zoneId] });
    const far = await requirementAt(FAR, { subjectIds: [math.id] });

    const hidden = await browse(headers, { scope: "set", setId: set.id });
    expect(idsOf(hidden.body)).not.toContain(far.id);

    // A zone of the set one kilometre from the student's pin brings the requirement back.
    const nearZone = await createTutorZone(tutor.id, { lat: FAR.lat, lng: FAR.lng, radiusM: 1000 });
    await prisma.tutorRequirementZone.create({
      data: { requirementId: set.id, tutorId: tutor.id, zoneId: nearZone },
    });
    const shown = await browse(headers, { scope: "set", setId: set.id });
    expect(idsOf(shown.body)).toContain(far.id);
  });

  it("an online requirement matches a set that teaches online, even when the student is outside Dhaka", async () => {
    const { tutor, headers } = await createBrowsingTutor();
    const zoneId = await createTutorZone(tutor.id, { radiusM: 5000 });
    const math = await createSubject();
    const online = await requirementAt(FAR, { subjectIds: [math.id], tuitionType: "Online" });

    const teaching = await createSet(tutor.id, [math.id], {
      name: "Teaches online",
      zoneIds: [zoneId],
      teachesOnline: true,
    });
    const listed = await browse(headers, { scope: "set", setId: teaching.id });
    expect(idsOf(listed.body)).toEqual([online.id]);

    const notOnline = await createSet(tutor.id, [math.id], {
      name: "No online",
      zoneIds: [zoneId],
      teachesOnline: false,
    });
    const hidden = await browse(headers, { scope: "set", setId: notOnline.id });
    expect(idsOf(hidden.body)).not.toContain(online.id);
  });

  it("returns match score and reasons for each row in set mode, and null match elsewhere", async () => {
    const { tutor, headers } = await createBrowsingTutor();
    const zoneId = await createTutorZone(tutor.id, { radiusM: 5000 });
    const math = await createSubject();
    const set = await createSet(tutor.id, [math.id], { isDefault: true, zoneIds: [zoneId] });
    const req = await requirementAt(TUTOR_PIN, { subjectIds: [math.id] });

    const inSet = await browse(headers, { scope: "set", setId: set.id });
    expect(inSet.body.matchVersion).toBe(0);
    const match = matchOf(inSet.body, req.id) as { score: number; reasons: unknown[] };
    expect(match.score).toBeGreaterThan(0);
    expect(match.score).toBeLessThanOrEqual(100);
    expect(match.reasons.length).toBeGreaterThan(0);
    expect(match.reasons[0]).toEqual({
      rule: expect.any(String),
      ok: expect.any(Boolean),
      label: expect.any(String),
    });
    expect(inSet.body.gaps).toEqual([]);

    const all = await browse(headers, { scope: "all" });
    expect(all.body.matchVersion).toBeNull();
    expect(all.body.gaps).toEqual([]);
    expect(matchOf(all.body, req.id)).toBeNull();
  });

  it("sort=match orders by score: a requirement inside the zone ranks above one 8 km away", async () => {
    const { tutor, headers } = await createBrowsingTutor();
    const zoneId = await createTutorZone(tutor.id, { radiusM: 2000 });
    const math = await createSubject();
    const set = await createSet(tutor.id, [math.id], { isDefault: true, zoneIds: [zoneId] });
    const far = await requirementAt(SOUTH_IN_CITY, { subjectIds: [math.id] });
    const inside = await requirementAt(TUTOR_PIN, { subjectIds: [math.id] });

    const res = await browse(headers, { scope: "set", setId: set.id, sort: "match" });
    expect(res.status).toBe(200);
    expect(idsOf(res.body)).toEqual([inside.id, far.id]);
    const scores = res.body.requirements.map((r: { match: { score: number } }) => r.match.score);
    expect(scores[0]).toBeGreaterThan(scores[1]);
    expect(res.body.nextCursor).toBeNull();
  });

  it("sort=match pages with an offset cursor, and a cursor from an older config version restarts at 0", async () => {
    const { tutor, headers } = await createBrowsingTutor();
    const zoneId = await createTutorZone(tutor.id, { radiusM: 5000 });
    const math = await createSubject();
    const set = await createSet(tutor.id, [math.id], { isDefault: true, zoneIds: [zoneId] });
    const { student } = await createStudentAt({ pin: TUTOR_PIN });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const req = await createRequirement({ studentId: student.id, subjectIds: [math.id] });
      await prisma.tuitionRequirement.update({
        where: { id: req.id },
        data: { createdAt: new Date(Date.UTC(2026, 0, 1 + i)) },
      });
      ids.push(req.id);
    }
    // Equal scores: the tie goes to the newest requirement.
    const newestFirst = [...ids].reverse();

    const first = await browse(headers, { scope: "set", setId: set.id, sort: "match", limit: 2 });
    expect(idsOf(first.body)).toEqual(newestFirst.slice(0, 2));
    expect(first.body.nextCursor).toEqual(expect.any(String));

    const second = await browse(headers, {
      scope: "set",
      setId: set.id,
      sort: "match",
      limit: 2,
      cursor: first.body.nextCursor,
    });
    expect(idsOf(second.body)).toEqual([newestFirst[2]]);
    expect(second.body.nextCursor).toBeNull();

    const stale = Buffer.from(JSON.stringify({ o: 2, v: 999 })).toString("base64url");
    const restarted = await browse(headers, {
      scope: "set",
      setId: set.id,
      sort: "match",
      limit: 2,
      cursor: stale,
    });
    expect(idsOf(restarted.body)).toEqual(newestFirst.slice(0, 2));

    const malformed = await browse(headers, {
      scope: "set",
      setId: set.id,
      sort: "match",
      cursor: "!!!",
    });
    expect(malformed.status).toBe(400);
    expect(malformed.body.code).toBe("VALIDATION_ERROR");
    expect(malformed.body.issues[0].path).toEqual(["cursor"]);
  });

  it("sort=match needs scope=set: 400 on sort for any other scope", async () => {
    const { headers } = await createBrowsingTutor();
    for (const scope of ["nearby", "all", "invited"]) {
      const res = await browse(headers, { scope, sort: "match" });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
      expect(res.body.issues[0].path).toEqual(["sort"]);
    }
  });

  it("gaps explain an empty set page: a wider level range would show the requirement", async () => {
    const { tutor, headers } = await createBrowsingTutor();
    const zoneId = await createTutorZone(tutor.id, { radiusM: 5000 });
    const math = await createSubject();
    const set = await createSet(tutor.id, [math.id], {
      isDefault: true,
      zoneIds: [zoneId],
      curricula: ["BANGLA_MEDIUM"],
      levelMin: 1,
      levelMax: 3,
    });
    await requirementAt(TUTOR_PIN, {
      subjectIds: [math.id],
      levelCode: 5,
      curriculum: "BANGLA_MEDIUM",
    });

    const res = await browse(headers, { scope: "set", setId: set.id });
    expect(res.body.requirements).toEqual([]);
    expect(res.body.gaps).toEqual([{ code: "WIDER_LEVEL", requirements: 1 }]);

    // Gaps come with the first page only.
    const withCursor = await browse(headers, {
      scope: "set",
      setId: set.id,
      cursor: Buffer.from(JSON.stringify(["2026-01-01T00:00:00.000Z", randomUUID()])).toString(
        "base64url",
      ),
    });
    expect(withCursor.body.gaps).toEqual([]);
  });

  it("scope=invited lists only the OPEN requirements the tutor was invited to, newest invite first", async () => {
    const { tutor, headers } = await createBrowsingTutor();
    const { tutor: rival } = await createBrowsingTutor();
    const { student } = await createStudentAt({ pin: FAR });
    const earlier = await createRequirement({ studentId: student.id });
    const later = await createRequirement({ studentId: student.id });
    const uninvited = await createRequirement({ studentId: student.id });
    const closedReq = await createRequirement({ studentId: student.id, status: "CLOSED" });

    const earlierAt = new Date("2026-03-01T10:00:00.000Z");
    const laterAt = new Date("2026-03-02T10:00:00.000Z");
    await prisma.requirementInvite.createMany({
      data: [
        {
          requirementId: earlier.id,
          tutorId: tutor.id,
          studentId: student.id,
          createdAt: earlierAt,
        },
        { requirementId: later.id, tutorId: tutor.id, studentId: student.id, createdAt: laterAt },
        { requirementId: closedReq.id, tutorId: tutor.id, studentId: student.id },
        { requirementId: uninvited.id, tutorId: rival.id, studentId: student.id },
      ],
    });

    const res = await browse(headers, { scope: "invited", curriculum: "ENGLISH_VERSION" });
    expect(res.status).toBe(200);
    expect(idsOf(res.body)).toEqual([later.id, earlier.id]);
    expect(res.body.requirements[0].invitedAt).toBe(laterAt.toISOString());
    expect(res.body.requirements[1].invitedAt).toBe(earlierAt.toISOString());
    expect(res.body.matchVersion).toBeNull();

    const paged = await browse(headers, { scope: "invited", limit: 1 });
    expect(idsOf(paged.body)).toEqual([later.id]);
    const next = await browse(headers, {
      scope: "invited",
      limit: 1,
      cursor: paged.body.nextCursor,
    });
    expect(idsOf(next.body)).toEqual([earlier.id]);
    expect(next.body.nextCursor).toBeNull();

    const all = await browse(headers, { scope: "all" });
    const plain = all.body.requirements.find((r: { id: string }) => r.id === uninvited.id);
    expect(plain.invitedAt).toBeNull();
  });

  it("returns 404 for another tutor's set and for an archived set of your own", async () => {
    const { tutor, headers } = await createBrowsingTutor();
    const { tutor: rival } = await createBrowsingTutor();
    const rivalSet = await createTutorRequirement(rival.id, { name: "Rival set" });
    const archived = await createTutorRequirement(tutor.id, { isActive: false });

    for (const setId of [rivalSet.id, archived.id]) {
      const res = await browse(headers, { scope: "set", setId });
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({
        code: "NOT_FOUND",
        message: "Requirement set not found",
      });
    }
  });

  it("returns 400 for scope=set without setId, and ignores setId with another scope", async () => {
    const { tutor, headers } = await createBrowsingTutor();
    const set = await createTutorRequirement(tutor.id);

    const missing = await browse(headers, { scope: "set" });
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe("VALIDATION_ERROR");

    const ignored = await browse(headers, { scope: "all", setId: set.id });
    expect(ignored.status).toBe(200);
  });
});
