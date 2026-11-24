import { describe, expect, it } from "vitest";
import { prisma } from "../../lib/prisma.js";
import {
  createAccount,
  createAdmin,
  createApplication,
  createArea,
  createFileAsset,
  createRequirement,
  createStudentProfile,
  createSubject,
  createTestApp,
  createTuitionPackage,
  createTutorProfile,
  createTutorRequirement,
  getAuthHeaders,
  setStudentLocation,
} from "../../tests/helpers.js";
import { softDeleteAccount } from "../auth/auth.service.js";

const BASE = "/api/v1/applications";

async function createStudent() {
  const account = await createAccount({ role: "STUDENT" });
  const area = await createArea();
  const student = await createStudentProfile(account.id, area.id);
  return { student, headers: await getAuthHeaders(account) };
}

// A tutor with a profile, an institute, an area and the given subjects on the profile.
async function createTutor(subjectIds: number[], areaId: number) {
  const account = await createAccount({ role: "TUTOR" });
  const tutor = await createTutorProfile(account.id);
  await prisma.tutor.update({
    where: { id: tutor.id },
    data: { instituteName: "University of Dhaka" },
  });
  await prisma.tutorArea.create({ data: { tutorId: tutor.id, areaId } });
  await prisma.tutorSubject.createMany({
    data: subjectIds.map((subjectId) => ({ tutorId: tutor.id, subjectId })),
  });
  return { tutor, headers: await getAuthHeaders(account) };
}

// A set for home tuition with no zones. Without zones a set that teaches online is online-only, so
// the matching sets here are home-only and their area (the requirement's area) carries the match.
async function createHomeSet(
  tutorId: string,
  overrides: Parameters<typeof createTutorRequirement>[1] = {},
) {
  const set = await createTutorRequirement(tutorId, overrides);
  return prisma.tutorRequirement.update({ where: { id: set.id }, data: { teachesOnline: false } });
}

async function getDetail(headers: Record<string, string>, id: string) {
  const app = await createTestApp();
  const res = await app.inject({ method: "GET", url: `${BASE}/${id}`, headers });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

describe("GET /applications/:id tutor details for the student (#4 of the follow-ups)", () => {
  it("gives the student the tutor profile and the matching set (MATCH), and the institute on tutor", async () => {
    const area = await createArea();
    const math = await createSubject();
    const { tutor } = await createTutor([math.id], area.id);
    const { student, headers: studentHeaders } = await createStudent();
    const requirement = await createRequirement({
      studentId: student.id,
      areaId: area.id,
      levelCode: 8,
      curriculum: "BANGLA_MEDIUM",
      subjectIds: [math.id],
    });
    // Default, but its curricula do not cover the requirement, so the matching set wins.
    await createTutorRequirement(tutor.id, {
      name: "Default",
      isDefault: true,
      subjectIds: [math.id],
      curricula: ["ENGLISH_VERSION"],
    });
    const matching = await createHomeSet(tutor.id, {
      name: "Evening Math",
      subjectIds: [math.id],
      curricula: ["BANGLA_MEDIUM"],
      levelMin: 6,
      levelMax: 10,
    });
    const credentialFile = await createFileAsset(tutor.accountId, "CREDENTIAL");
    const credential = await prisma.tutorCredential.create({
      data: { tutorId: tutor.id, examLabel: "HSC", result: "5.00", fileId: credentialFile.id },
    });
    const application = await createApplication({
      requirementId: requirement.id,
      tutorId: tutor.id,
      studentId: student.id,
      initiatedBy: "TUTOR",
    });

    const res = await getDetail(studentHeaders, application.id);
    expect(res.status).toBe(200);
    expect(res.body.tutorSet).toEqual({
      matchedBy: "MATCH",
      set: {
        id: matching.id,
        name: "Evening Math",
        isDefault: false,
        levelMin: 6,
        levelMax: 10,
        curricula: ["BANGLA_MEDIUM"],
        academicGroups: [],
        admissionTargets: [],
        subjectIds: [math.id],
        timeFrom: "10:00",
        timeTo: "12:00",
        availableDays: 127,
        daysPerWeek: null,
        minSalary: null,
        maxStudents: 1,
        teachesOnline: false,
      },
    });
    expect(res.body.tutorProfile).toEqual({
      id: tutor.id,
      name: "Test Tutor",
      gender: "MALE",
      instituteName: "University of Dhaka",
      ratingAvg: 0,
      ratingCount: 0,
      verificationStatus: "NOT_SUBMITTED",
      verifiedBadge: false,
      avatarUrl: null,
      areas: [{ id: area.id, name: area.name }],
      subjects: [{ id: math.id, name: math.name }],
      credentials: [{ id: credential.id, examLabel: "HSC", result: "5.00" }],
    });
    expect(res.body.tutor.instituteName).toBe("University of Dhaka");

    const app = await createTestApp();
    const list = await app.inject({ method: "GET", url: BASE, headers: studentHeaders });
    expect(JSON.parse(list.body).applications[0].tutor.instituteName).toBe("University of Dhaka");
  });

  it("falls back to the default set (DEFAULT) when no set covers the requirement", async () => {
    const area = await createArea();
    const math = await createSubject();
    const { tutor } = await createTutor([math.id], area.id);
    const { student, headers: studentHeaders } = await createStudent();
    const requirement = await createRequirement({
      studentId: student.id,
      areaId: area.id,
      levelCode: 8,
      curriculum: "BANGLA_MEDIUM",
      subjectIds: [math.id],
    });
    const fallback = await createTutorRequirement(tutor.id, {
      name: "Default",
      isDefault: true,
      subjectIds: [math.id],
      curricula: ["ENGLISH_VERSION"],
    });
    const application = await createApplication({
      requirementId: requirement.id,
      tutorId: tutor.id,
      studentId: student.id,
      initiatedBy: "TUTOR",
    });

    const res = await getDetail(studentHeaders, application.id);
    expect(res.body.tutorSet).toMatchObject({ matchedBy: "DEFAULT", set: { id: fallback.id } });
  });

  it("ranks matching sets: a matching default first, then the most shared subjects", async () => {
    const area = await createArea();
    const math = await createSubject();
    const english = await createSubject();
    const { tutor } = await createTutor([math.id, english.id], area.id);
    const { student, headers: studentHeaders } = await createStudent();
    const requirement = await createRequirement({
      studentId: student.id,
      areaId: area.id,
      levelCode: 8,
      curriculum: "BANGLA_MEDIUM",
      subjectIds: [math.id, english.id],
    });
    const application = await createApplication({
      requirementId: requirement.id,
      tutorId: tutor.id,
      studentId: student.id,
      initiatedBy: "TUTOR",
    });
    // Two matching sets. The older one shares two subjects, the newer one shares one, so the
    // shared count wins over recency.
    const twoShared = await createHomeSet(tutor.id, {
      name: "Two shared",
      subjectIds: [math.id, english.id],
    });
    await createHomeSet(tutor.id, { name: "One shared", subjectIds: [math.id] });

    const bySubjects = await getDetail(studentHeaders, application.id);
    expect(bySubjects.body.tutorSet).toMatchObject({
      matchedBy: "MATCH",
      set: { id: twoShared.id },
    });

    // A matching default set beats both. It shares both subjects too, so the scores tie and the
    // default flag decides.
    const defaultSet = await createHomeSet(tutor.id, {
      name: "Default",
      isDefault: true,
      subjectIds: [math.id, english.id],
    });
    const byDefault = await getDetail(studentHeaders, application.id);
    expect(byDefault.body.tutorSet).toMatchObject({
      matchedBy: "MATCH",
      set: { id: defaultSet.id },
    });
  });

  it("gives no set when the tutor has neither a match nor a default set", async () => {
    const area = await createArea();
    const math = await createSubject();
    const { tutor } = await createTutor([math.id], area.id);
    const { student, headers: studentHeaders } = await createStudent();
    const requirement = await createRequirement({
      studentId: student.id,
      areaId: area.id,
      levelCode: 8,
      curriculum: "BANGLA_MEDIUM",
      subjectIds: [math.id],
    });
    await createTutorRequirement(tutor.id, {
      subjectIds: [math.id],
      curricula: ["ENGLISH_VERSION"],
    });
    const application = await createApplication({
      requirementId: requirement.id,
      tutorId: tutor.id,
      studentId: student.id,
      initiatedBy: "TUTOR",
    });

    const res = await getDetail(studentHeaders, application.id);
    expect(res.body.tutorSet).toBeNull();
    expect(res.body.tutorProfile).not.toBeNull();
  });

  it("gives no tutor set on a package application; the target carries the package offer", async () => {
    const area = await createArea();
    const math = await createSubject();
    const { tutor } = await createTutor([math.id], area.id);
    await createTutorRequirement(tutor.id, { isDefault: true, subjectIds: [math.id] });
    const pkg = await createTuitionPackage(tutor.id, { subjectIds: [math.id], price: 18000 });
    const { student, headers: studentHeaders } = await createStudent();
    const application = await createApplication({
      packageId: pkg.id,
      tutorId: tutor.id,
      studentId: student.id,
      initiatedBy: "STUDENT",
    });

    const res = await getDetail(studentHeaders, application.id);
    expect(res.body.tutorSet).toBeNull();
    expect(res.body.tutorProfile).not.toBeNull();
    expect(res.body.target).toMatchObject({
      kind: "PACKAGE",
      id: pkg.id,
      subjectIds: [math.id],
      price: 18000,
      salary: null,
      title: pkg.title,
      durationWeeks: pkg.durationWeeks,
      timeOfDay: "10:00",
    });
  });

  it("hides the tutor profile and set from the tutor side", async () => {
    const area = await createArea();
    const math = await createSubject();
    const { tutor, headers: tutorHeaders } = await createTutor([math.id], area.id);
    await createTutorRequirement(tutor.id, { isDefault: true, subjectIds: [math.id] });
    const { student } = await createStudent();
    const requirement = await createRequirement({
      studentId: student.id,
      areaId: area.id,
      subjectIds: [math.id],
    });
    const application = await createApplication({
      requirementId: requirement.id,
      tutorId: tutor.id,
      studentId: student.id,
      initiatedBy: "TUTOR",
    });

    const res = await getDetail(tutorHeaders, application.id);
    expect(res.status).toBe(200);
    expect(res.body.tutorProfile).toBeNull();
    expect(res.body.tutorSet).toBeNull();
    expect(res.body.tutor.instituteName).toBe("University of Dhaka");
  });

  it("shows admins the same tutor profile and set as the student", async () => {
    const area = await createArea();
    const math = await createSubject();
    const { tutor } = await createTutor([math.id], area.id);
    const set = await createHomeSet(tutor.id, { isDefault: true, subjectIds: [math.id] });
    const { student } = await createStudent();
    const requirement = await createRequirement({
      studentId: student.id,
      areaId: area.id,
      subjectIds: [math.id],
    });
    const application = await createApplication({
      requirementId: requirement.id,
      tutorId: tutor.id,
      studentId: student.id,
      initiatedBy: "TUTOR",
    });
    const admin = await createAdmin();

    const res = await getDetail(await getAuthHeaders(admin), application.id);
    expect(res.status).toBe(200);
    expect(res.body.tutorProfile).toMatchObject({ id: tutor.id });
    expect(res.body.tutorSet).toMatchObject({ matchedBy: "MATCH", set: { id: set.id } });
  });
});

describe("GET /applications/:id student location for the tutor", () => {
  async function confirmedRequirementApp(status: "CONFIRMED" | "PENDING" = "CONFIRMED") {
    const area = await createArea();
    const math = await createSubject();
    const { tutor, headers: tutorHeaders } = await createTutor([math.id], area.id);
    const { student, headers: studentHeaders } = await createStudent();
    const requirement = await createRequirement({
      studentId: student.id,
      areaId: area.id,
      subjectIds: [math.id],
    });
    const application = await createApplication({
      requirementId: requirement.id,
      tutorId: tutor.id,
      studentId: student.id,
      initiatedBy: "TUTOR",
      status,
    });
    return { student, application, tutorHeaders, studentHeaders };
  }

  it("gives the tutor the saved address, coordinates and place id on a CONFIRMED application", async () => {
    const { student, application, tutorHeaders } = await confirmedRequirementApp();
    await setStudentLocation(student.id, { lat: 23.7808, lng: 90.4193 });

    const res = await getDetail(tutorHeaders, application.id);
    expect(res.status).toBe(200);
    expect(res.body.studentLocation).toMatchObject({
      address: "Student Address",
      placeId: `place-${student.id}`,
    });
    expect(res.body.studentLocation.lat).toBeCloseTo(23.7808, 4);
    expect(res.body.studentLocation.lng).toBeCloseTo(90.4193, 4);
  });

  it("gives the tutor the location on a COMPLETED application", async () => {
    const { student, application, tutorHeaders } = await confirmedRequirementApp();
    await prisma.application.update({
      where: { id: application.id },
      data: { status: "COMPLETED", endedAt: new Date() },
    });
    await setStudentLocation(student.id);

    const res = await getDetail(tutorHeaders, application.id);
    expect(res.body.studentLocation).toMatchObject({ address: "Student Address" });
  });

  it("gives null on a PENDING application even when the student has a location", async () => {
    const { student, application, tutorHeaders } = await confirmedRequirementApp("PENDING");
    await setStudentLocation(student.id);

    const res = await getDetail(tutorHeaders, application.id);
    expect(res.body.studentLocation).toBeNull();
  });

  it("gives null to the student, and to an admin", async () => {
    const { student, application, studentHeaders } = await confirmedRequirementApp();
    await setStudentLocation(student.id);

    const studentRes = await getDetail(studentHeaders, application.id);
    expect(studentRes.body.studentLocation).toBeNull();

    const adminRes = await getDetail(await getAuthHeaders(await createAdmin()), application.id);
    expect(adminRes.status).toBe(200);
    expect(adminRes.body.studentLocation).toBeNull();
  });

  it("keeps the address and nulls the coordinates when the location has no geog (expired)", async () => {
    const { student, application, tutorHeaders } = await confirmedRequirementApp();
    await setStudentLocation(student.id);
    await prisma.$executeRaw`UPDATE student_location SET geog = NULL WHERE student_id = ${student.id}`;

    const res = await getDetail(tutorHeaders, application.id);
    expect(res.body.studentLocation).toEqual({
      address: "Student Address",
      lat: null,
      lng: null,
      placeId: `place-${student.id}`,
    });
  });

  it("falls back to the student's profile address with null coordinates when there is no location row", async () => {
    const { application, tutorHeaders } = await confirmedRequirementApp();

    const res = await getDetail(tutorHeaders, application.id);
    expect(res.body.studentLocation).toEqual({
      address: "123 Test Lane",
      lat: null,
      lng: null,
      placeId: null,
    });
  });

  it("shows the student location on a CONFIRMED package request", async () => {
    const area = await createArea();
    const math = await createSubject();
    const { tutor, headers: tutorHeaders } = await createTutor([math.id], area.id);
    const pkg = await createTuitionPackage(tutor.id, { subjectIds: [math.id], price: 18000 });
    const { student } = await createStudent();
    await setStudentLocation(student.id, { lat: 23.7808, lng: 90.4193 });
    const application = await createApplication({
      packageId: pkg.id,
      tutorId: tutor.id,
      studentId: student.id,
      initiatedBy: "STUDENT",
      status: "CONFIRMED",
    });

    const res = await getDetail(tutorHeaders, application.id);
    expect(res.body.target.kind).toBe("PACKAGE");
    expect(res.body.studentLocation).toMatchObject({
      address: "Student Address",
      placeId: `place-${student.id}`,
    });
    expect(res.body.studentLocation.lat).toBeCloseTo(23.7808, 4);
  });

  it.each(["CANCELLED", "WITHDRAWN", "REJECTED", "EXPIRED"] as const)(
    "gives null on a %s application",
    async (status) => {
      const { student, application, tutorHeaders } = await confirmedRequirementApp("PENDING");
      await setStudentLocation(student.id);
      await prisma.application.update({
        where: { id: application.id },
        data: status === "CANCELLED" ? { status, endedAt: new Date() } : { status },
      });

      const res = await getDetail(tutorHeaders, application.id);
      expect(res.body.studentLocation).toBeNull();
    },
  );

  it("returns 404 to another tutor, with no studentLocation in the body", async () => {
    const { student, application } = await confirmedRequirementApp();
    await setStudentLocation(student.id);
    const area = await createArea();
    const math = await createSubject();
    const { headers: otherHeaders } = await createTutor([math.id], area.id);

    const res = await getDetail(otherHeaders, application.id);
    expect(res.status).toBe(404);
    expect(res.body.studentLocation).toBeUndefined();
  });

  it("gives null once the student's account is soft-deleted", async () => {
    const { student, application, tutorHeaders } = await confirmedRequirementApp();
    await setStudentLocation(student.id);
    await softDeleteAccount(student.accountId);

    const res = await getDetail(tutorHeaders, application.id);
    expect(res.status).toBe(200);
    expect(res.body.studentLocation).toBeNull();
  });

  it("returns the coordinates when the location needs a readdress but still has geog", async () => {
    const { student, application, tutorHeaders } = await confirmedRequirementApp();
    await setStudentLocation(student.id, { lat: 23.7808, lng: 90.4193, needsReaddress: true });

    const res = await getDetail(tutorHeaders, application.id);
    expect(res.body.studentLocation.lat).toBeCloseTo(23.7808, 4);
    expect(res.body.studentLocation.lng).toBeCloseTo(90.4193, 4);
  });
});
