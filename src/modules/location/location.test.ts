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
        placeId: "place-1",
        latitude: 23.81,
        longitude: 90.41,
        districtCode: "dhaka",
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
        placeId: "place-2",
        latitude: 23.73,
        longitude: 90.4,
        districtCode: "dhaka",
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
