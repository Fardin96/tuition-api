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
} from "../../tests/helpers.js";

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
    const matching = await createTutorRequirement(tutor.id, {
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
        teachesOnline: true,
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
    const twoShared = await createTutorRequirement(tutor.id, {
      name: "Two shared",
      subjectIds: [math.id, english.id],
    });
    await createTutorRequirement(tutor.id, { name: "One shared", subjectIds: [math.id] });

    const bySubjects = await getDetail(studentHeaders, application.id);
    expect(bySubjects.body.tutorSet).toMatchObject({
      matchedBy: "MATCH",
      set: { id: twoShared.id },
    });

    // A matching default set beats both.
    const defaultSet = await createTutorRequirement(tutor.id, {
      name: "Default",
      isDefault: true,
      subjectIds: [math.id],
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

  it("gives the package's own set (PACKAGE) on a package application", async () => {
    const area = await createArea();
    const math = await createSubject();
    const { tutor } = await createTutor([math.id], area.id);
    await createTutorRequirement(tutor.id, { isDefault: true, subjectIds: [math.id] });
    const packageSet = await createTutorRequirement(tutor.id, {
      name: "Package set",
      subjectIds: [math.id],
    });
    const pkg = await createTuitionPackage(tutor.id, {
      requirementId: packageSet.id,
      subjectId: math.id,
    });
    const { student, headers: studentHeaders } = await createStudent();
    const application = await createApplication({
      packageId: pkg.id,
      tutorId: tutor.id,
      studentId: student.id,
      initiatedBy: "STUDENT",
    });

    const res = await getDetail(studentHeaders, application.id);
    expect(res.body.tutorSet).toMatchObject({ matchedBy: "PACKAGE", set: { id: packageSet.id } });
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
    const set = await createTutorRequirement(tutor.id, { isDefault: true, subjectIds: [math.id] });
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
