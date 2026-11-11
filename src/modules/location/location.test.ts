import { describe, expect, it } from "vitest";
import { prisma } from "../../lib/prisma.js";
import {
  createAccount,
  createArea,
  createStudentProfile,
  createTestApp,
  createTutorProfile,
  getAuthHeaders,
  setStudentLocation,
  setTutorLocation,
} from "../../tests/helpers.js";
import { findNearbyTutors, runLocationExpiry } from "./location.service.js";

describe("location service and routes", () => {
  it("stores a location when creating/updating a tutor profile", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "TUTOR" });
    const headers = await getAuthHeaders(account);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/tutors/me",
      headers,
      payload: {
        name: "Tutor Name",
        address: "Tutor Address",
        emergencyContact: "+8801700000002",
        whatsappNumber: "+8801700000002",
        studentIdNumber: "TUTOR-1",
        gender: "MALE",
        location: {
          lat: 23.81,
          lng: 90.41,
          addressText: "Some Road",
          district: "Dhaka",
          placeId: "place-1",
        },
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.needsReaddress).toBe(false);

    const tutor = await prisma.tutor.findUnique({ where: { accountId: account.id } });
    const rows = await prisma.$queryRaw<{ count: number }[]>`
      SELECT count(*)::int AS count FROM tutor_location WHERE tutor_id = ${tutor?.id}
    `;
    expect(rows[0]?.count).toBe(1);
  });

  it("stores a location when creating a student profile", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    const headers = await getAuthHeaders(account);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/students/me",
      headers,
      payload: {
        name: "Student Name",
        areaId: area.id,
        address: "Student Address",
        emergencyContact: "+8801700000001",
        whatsappNumber: "+8801700000001",
        studentIdNumber: "STU-1",
        location: {
          lat: 23.73,
          lng: 90.4,
          addressText: "Some Road",
          district: "Dhaka",
          placeId: "place-2",
        },
      },
    });

    expect(res.statusCode).toBe(201);
    const student = await prisma.student.findUnique({ where: { accountId: account.id } });
    const rows = await prisma.$queryRaw<{ count: number }[]>`
      SELECT count(*)::int AS count FROM student_location WHERE student_id = ${student?.id}
    `;
    expect(rows[0]?.count).toBe(1);
  });

  it("finds nearby tutors by geo distance", async () => {
    const studentAccount = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    const student = await createStudentProfile(studentAccount.id, area.id);
    await setStudentLocation(student.id, { districtCode: "dhaka", lat: 23.73, lng: 90.4 });

    const closeAccount = await createAccount({ role: "TUTOR" });
    const closeTutor = await createTutorProfile(closeAccount.id, { isListed: true });
    await setTutorLocation(closeTutor.id, { districtCode: "dhaka", lat: 23.735, lng: 90.405 });

    const farAccount = await createAccount({ role: "TUTOR" });
    const farTutor = await createTutorProfile(farAccount.id, { isListed: true });
    await setTutorLocation(farTutor.id, { districtCode: "dhaka", lat: 23.81, lng: 90.41 });

    const otherDistrictAccount = await createAccount({ role: "TUTOR" });
    const otherDistrictTutor = await createTutorProfile(otherDistrictAccount.id, {
      isListed: true,
    });
    await setTutorLocation(otherDistrictTutor.id, {
      districtCode: "ctg",
      lat: 23.735,
      lng: 90.405,
    });

    const tutors = await findNearbyTutors(studentAccount.id, 2000);
    expect(tutors).toHaveLength(1);
    expect(tutors[0]?.id).toBe(closeTutor.id);
    expect(tutors[0]?.distanceMeters).toBeLessThan(2000);
  });

  it("GET /api/v1/tutors/nearby returns tutors for an authenticated student", async () => {
    const app = await createTestApp();
    const studentAccount = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    const student = await createStudentProfile(studentAccount.id, area.id);
    await setStudentLocation(student.id, { districtCode: "dhaka", lat: 23.73, lng: 90.4 });

    const tutorAccount = await createAccount({ role: "TUTOR" });
    const tutor = await createTutorProfile(tutorAccount.id, { isListed: true });
    await setTutorLocation(tutor.id, { districtCode: "dhaka", lat: 23.735, lng: 90.405 });

    const headers = await getAuthHeaders(studentAccount);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/tutors/nearby?radiusMeters=2000",
      headers,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.tutors).toHaveLength(1);
    expect(body.tutors[0]?.id).toBe(tutor.id);
    expect(body.tutors[0]?.distanceMeters).toBeLessThan(2000);
  });

  it("GET /api/v1/me exposes needsReaddress for tutors", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "TUTOR" });
    const tutor = await createTutorProfile(account.id);
    await setTutorLocation(tutor.id, { districtCode: "dhaka", needsReaddress: true });
    const headers = await getAuthHeaders(account);

    const res = await app.inject({ method: "GET", url: "/api/v1/me", headers });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.account.tutor.needsReaddress).toBe(true);
  });

  it("marks stale rows for re-address at 21 days and nulls geog at 28 days", async () => {
    const softOnly = await createAccount({ role: "TUTOR" });
    const softTutor = await createTutorProfile(softOnly.id);
    await setTutorLocation(softTutor.id, { districtCode: "dhaka", lat: 23.73, lng: 90.4 });

    const softFetchedAt = new Date();
    softFetchedAt.setDate(softFetchedAt.getDate() - 22);
    await prisma.$executeRaw`
      UPDATE tutor_location SET geog_fetched_at = ${softFetchedAt}, needs_readdress = false
      WHERE tutor_id = ${softTutor.id}
    `;

    const hardOnly = await createAccount({ role: "TUTOR" });
    const hardTutor = await createTutorProfile(hardOnly.id);
    await setTutorLocation(hardTutor.id, { districtCode: "dhaka", lat: 23.74, lng: 90.41 });

    const hardFetchedAt = new Date();
    hardFetchedAt.setDate(hardFetchedAt.getDate() - 35);
    await prisma.$executeRaw`
      UPDATE tutor_location SET geog_fetched_at = ${hardFetchedAt}, needs_readdress = false
      WHERE tutor_id = ${hardTutor.id}
    `;

    const result = await runLocationExpiry();
    expect(result.softWarning.tutorCount).toBe(2);
    expect(result.hardExpiry.tutorCount).toBe(1);

    const [softRow] = await prisma.$queryRaw<{ geog: unknown; needs_readdress: boolean }[]>`
      SELECT geog, needs_readdress FROM tutor_location WHERE tutor_id = ${softTutor.id}
    `;
    expect(softRow?.needs_readdress).toBe(true);
    expect(softRow?.geog).not.toBeNull();

    const [hardRow] = await prisma.$queryRaw<{ geog: unknown; needs_readdress: boolean }[]>`
      SELECT geog, needs_readdress FROM tutor_location WHERE tutor_id = ${hardTutor.id}
    `;
    expect(hardRow?.needs_readdress).toBe(true);
    expect(hardRow?.geog).toBeNull();
  });
});

describe("location payload", () => {
  const location = {
    lat: 23.81,
    lng: 90.41,
    addressText: "Road 1, Dhanmondi",
    district: "Dhaka",
  };
  const tutorBody = {
    name: "Tutor Name",
    address: "Tutor Address",
    emergencyContact: "+8801700000002",
    whatsappNumber: "+8801700000002",
    studentIdNumber: "TUTOR-1",
    gender: "MALE",
  };

  async function tutorLocationRow(tutorId: string) {
    const [row] = await prisma.$queryRaw<
      { geog_source: string; place_id: string | null; district_code: string }[]
    >`SELECT geog_source, place_id, district_code FROM tutor_location WHERE tutor_id = ${tutorId}`;
    return row;
  }

  it("rejects coordinates outside Bangladesh", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "TUTOR" });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/tutors/me",
      headers: await getAuthHeaders(account),
      payload: { ...tutorBody, location: { ...location, lat: 10, lng: 100 } },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an unknown district", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "TUTOR" });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/tutors/me",
      headers: await getAuthHeaders(account),
      payload: { ...tutorBody, location: { ...location, district: "Atlantis" } },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a partial location object", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    const { lng: _lng, ...partial } = location;
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/students/me",
      headers: await getAuthHeaders(account),
      payload: {
        name: "Student Name",
        areaId: area.id,
        address: "Student Address",
        emergencyContact: "+8801700000001",
        whatsappNumber: "+8801700000001",
        studentIdNumber: "STU-1",
        location: partial,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("maps district aliases to canonical codes", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "TUTOR" });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/tutors/me",
      headers: await getAuthHeaders(account),
      payload: { ...tutorBody, location: { ...location, district: "Chittagong District" } },
    });
    expect(res.statusCode).toBe(201);
    const tutor = await prisma.tutor.findUniqueOrThrow({ where: { accountId: account.id } });
    expect((await tutorLocationRow(tutor.id))?.district_code).toBe("chattogram");
  });

  it("marks a pin without placeId as PIN and one with placeId as PLACES", async () => {
    const app = await createTestApp();
    const pinAccount = await createAccount({ role: "TUTOR" });
    const placesAccount = await createAccount({ role: "TUTOR" });

    await app.inject({
      method: "POST",
      url: "/api/v1/tutors/me",
      headers: await getAuthHeaders(pinAccount),
      payload: { ...tutorBody, location },
    });
    await app.inject({
      method: "POST",
      url: "/api/v1/tutors/me",
      headers: await getAuthHeaders(placesAccount),
      payload: {
        ...tutorBody,
        whatsappNumber: "+8801700000003",
        location: { ...location, placeId: "place-9" },
      },
    });

    const pinTutor = await prisma.tutor.findUniqueOrThrow({ where: { accountId: pinAccount.id } });
    const placesTutor = await prisma.tutor.findUniqueOrThrow({
      where: { accountId: placesAccount.id },
    });
    expect(await tutorLocationRow(pinTutor.id)).toMatchObject({
      geog_source: "PIN",
      place_id: null,
    });
    expect(await tutorLocationRow(placesTutor.id)).toMatchObject({
      geog_source: "PLACES",
      place_id: "place-9",
    });
  });

  it("returns the owner's location from GET /me and keeps it on PATCH without location", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "TUTOR" });
    const headers = await getAuthHeaders(account);
    await app.inject({
      method: "POST",
      url: "/api/v1/tutors/me",
      headers,
      payload: { ...tutorBody, location: { ...location, placeId: "place-3" } },
    });

    const patch = await app.inject({
      method: "PATCH",
      url: "/api/v1/tutors/me",
      headers,
      payload: { name: "Renamed" },
    });
    expect(patch.statusCode).toBe(200);
    expect(JSON.parse(patch.body).location).toMatchObject({
      lat: 23.81,
      lng: 90.41,
      districtCode: "dhaka",
      placeId: "place-3",
    });

    const me = await app.inject({ method: "GET", url: "/api/v1/me", headers });
    expect(JSON.parse(me.body).account.tutor.location).toMatchObject({
      lat: 23.81,
      lng: 90.41,
      addressText: "Road 1, Dhanmondi",
      districtCode: "dhaka",
      placeId: "place-3",
      needsReaddress: false,
    });
  });

  it("GET /me returns the student location", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    const headers = await getAuthHeaders(account);
    await app.inject({
      method: "POST",
      url: "/api/v1/students/me",
      headers,
      payload: {
        name: "Student Name",
        areaId: area.id,
        address: "Student Address",
        emergencyContact: "+8801700000001",
        whatsappNumber: "+8801700000001",
        studentIdNumber: "STU-1",
        location,
      },
    });

    const me = await app.inject({ method: "GET", url: "/api/v1/me", headers });
    expect(JSON.parse(me.body).account.student.location).toMatchObject({
      lat: 23.81,
      districtCode: "dhaka",
      placeId: null,
    });
  });

  it("lists a new tutor when verification is not required", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "TUTOR" });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/tutors/me",
      headers: await getAuthHeaders(account),
      payload: tutorBody,
    });
    expect(res.statusCode).toBe(201);
    const tutor = await prisma.tutor.findUniqueOrThrow({ where: { accountId: account.id } });
    expect(tutor.isListed).toBe(true);
  });
});
