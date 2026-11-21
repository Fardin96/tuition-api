import { beforeEach, describe, expect, it } from "vitest";
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
  getAuthHeaders,
  setPlatformSetting,
} from "../../tests/helpers.js";

const sorted = (ids: number[]) => [...ids].sort((a, b) => a - b);

describe("requirement module", () => {
  it("should create a requirement with defaults", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    const subject = await createSubject();
    const studentProfile = await createStudentProfile(account.id, area.id);
    const authHeaders = await getAuthHeaders(account);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/requirements/",
      headers: authHeaders,
      payload: {
        areaId: area.id,
        subjectIds: [subject.id],
        curriculum: "BANGLA_MEDIUM",
        levelCode: 10,
        timeOfDay: "10:00",
        daysPerWeek: 3,
        salary: 5000,
        hireByDate: "2024-12-31",
        tuitionType: "Home Tutoring Solo",
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toHaveProperty("id");
    expect(body.studentId).toBe(studentProfile.id);
    expect(body.curriculum).toBe("BANGLA_MEDIUM");
    expect(body.levelCode).toBe(10);
    expect(body.academicGroup).toBeNull();
    expect(body.admissionTargets).toEqual([]);
    expect(body.isRetaker).toBe(false);
    expect(body.levelNote).toBeNull();
    expect(body.areaId).toBe(area.id);
    expect(body.subjectIds).toEqual([subject.id]);
    expect(body.timeOfDay).toBe("10:00");
    expect(body.daysPerWeek).toBe(3);
    expect(body.salary).toBe(5000);
    expect(body.studentCount).toBe(1);
    expect(body.hireByDate).toBe("2024-12-31");
    expect(body.tutorGenderPref).toBe("ANY");
    expect(body.tuitionType).toBe("Home Tutoring Solo");
    expect(body.status).toBe("OPEN");
  });

  it("should create a draft requirement", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    const subject = await createSubject();
    await createStudentProfile(account.id, area.id);
    const authHeaders = await getAuthHeaders(account);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/requirements/",
      headers: authHeaders,
      payload: {
        areaId: area.id,
        subjectIds: [subject.id],
        curriculum: "BANGLA_MEDIUM",
        levelCode: 10,
        timeOfDay: "10:00",
        daysPerWeek: 3,
        salary: 5000,
        hireByDate: "2024-12-31",
        tuitionType: "Home Tutoring Solo",
        status: "DRAFT",
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.status).toBe("DRAFT");
  });

  it("should get requirements for student", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    const subject = await createSubject();
    const studentProfile = await createStudentProfile(account.id, area.id);
    const authHeaders = await getAuthHeaders(account);

    const requirement = await createRequirement({
      studentId: studentProfile.id,
      areaId: area.id,
      subjectId: subject.id,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/requirements/mine",
      headers: authHeaders,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.requirements).toHaveLength(1);
    expect(body.requirements[0].id).toBe(requirement.id);
    expect(body.requirements[0].studentId).toBe(studentProfile.id);
  });

  it("should get a specific requirement by id", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    const subject = await createSubject();
    const studentProfile = await createStudentProfile(account.id, area.id);
    const authHeaders = await getAuthHeaders(account);

    const requirement = await createRequirement({
      studentId: studentProfile.id,
      areaId: area.id,
      subjectId: subject.id,
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/requirements/${requirement.id}`,
      headers: authHeaders,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.id).toBe(requirement.id);
    expect(body.studentId).toBe(studentProfile.id);
  });

  it("should update a requirement without resetting omitted fields", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    const subject = await createSubject();
    const studentProfile = await createStudentProfile(account.id, area.id);
    const authHeaders = await getAuthHeaders(account);

    const requirement = await createRequirement({
      studentId: studentProfile.id,
      areaId: area.id,
      subjectId: subject.id,
      studentCount: 3,
      tutorGenderPref: "FEMALE",
    });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/requirements/${requirement.id}`,
      headers: authHeaders,
      payload: {
        levelCode: 11,
        salary: 6000,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.levelCode).toBe(11);
    expect(body.curriculum).toBe("BANGLA_MEDIUM");
    expect(body.salary).toBe(6000);
    expect(body.studentCount).toBe(3);
    expect(body.tutorGenderPref).toBe("FEMALE");
  });

  it("should update a draft requirement to open", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    const subject = await createSubject();
    const studentProfile = await createStudentProfile(account.id, area.id);
    const authHeaders = await getAuthHeaders(account);

    const requirement = await createRequirement({
      studentId: studentProfile.id,
      areaId: area.id,
      subjectId: subject.id,
      status: "DRAFT",
    });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/requirements/${requirement.id}`,
      headers: authHeaders,
      payload: {
        status: "OPEN",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("OPEN");
  });

  it("should close a requirement", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    const subject = await createSubject();
    const studentProfile = await createStudentProfile(account.id, area.id);
    const authHeaders = await getAuthHeaders(account);

    const requirement = await createRequirement({
      studentId: studentProfile.id,
      areaId: area.id,
      subjectId: subject.id,
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/requirements/${requirement.id}/close`,
      headers: authHeaders,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("CLOSED");
  });

  it("should return 409 when closing an already-closed requirement", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    const subject = await createSubject();
    const studentProfile = await createStudentProfile(account.id, area.id);
    const authHeaders = await getAuthHeaders(account);

    const requirement = await createRequirement({
      studentId: studentProfile.id,
      areaId: area.id,
      subjectId: subject.id,
      status: "CLOSED",
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/requirements/${requirement.id}/close`,
      headers: authHeaders,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().message).toContain("Cannot close requirement");
  });

  it("should return 409 when editing an already-closed requirement", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    const subject = await createSubject();
    const studentProfile = await createStudentProfile(account.id, area.id);
    const authHeaders = await getAuthHeaders(account);

    const requirement = await createRequirement({
      studentId: studentProfile.id,
      areaId: area.id,
      subjectId: subject.id,
      status: "CLOSED",
    });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/requirements/${requirement.id}`,
      headers: authHeaders,
      payload: {
        salary: 7000,
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().message).toContain("Cannot modify requirement");
  });

  it("should not allow getting another student's requirement", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    const subject = await createSubject();
    await createStudentProfile(account.id, area.id);
    const authHeaders = await getAuthHeaders(account);

    const otherAccount = await createAccount({ role: "STUDENT" });
    const otherStudentProfile = await createStudentProfile(otherAccount.id, area.id);

    const requirement = await createRequirement({
      studentId: otherStudentProfile.id,
      areaId: area.id,
      subjectId: subject.id,
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/requirements/${requirement.id}`,
      headers: authHeaders,
    });

    expect(response.statusCode).toBe(404);
  });

  it("should not allow updating another student's requirement", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    const subject = await createSubject();
    await createStudentProfile(account.id, area.id);
    const authHeaders = await getAuthHeaders(account);

    const otherAccount = await createAccount({ role: "STUDENT" });
    const otherStudentProfile = await createStudentProfile(otherAccount.id, area.id);

    const requirement = await createRequirement({
      studentId: otherStudentProfile.id,
      areaId: area.id,
      subjectId: subject.id,
    });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/requirements/${requirement.id}`,
      headers: authHeaders,
      payload: {
        levelCode: 11,
      },
    });

    expect(response.statusCode).toBe(404);
  });

  it("should not allow closing another student's requirement", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    const subject = await createSubject();
    await createStudentProfile(account.id, area.id);
    const authHeaders = await getAuthHeaders(account);

    const otherAccount = await createAccount({ role: "STUDENT" });
    const otherStudentProfile = await createStudentProfile(otherAccount.id, area.id);

    const requirement = await createRequirement({
      studentId: otherStudentProfile.id,
      areaId: area.id,
      subjectId: subject.id,
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/requirements/${requirement.id}/close`,
      headers: authHeaders,
    });

    expect(response.statusCode).toBe(404);
  });

  it("should not allow non-students to access requirements", async () => {
    const app = await createTestApp();
    const tutorAccount = await createAccount({ role: "TUTOR" });
    const tutorAuthHeaders = await getAuthHeaders(tutorAccount);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/requirements/mine",
      headers: tutorAuthHeaders,
    });

    expect(response.statusCode).toBe(403);
  });

  it("should return 404 when student profile does not exist yet", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    const subject = await createSubject();
    const authHeaders = await getAuthHeaders(account);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/requirements/",
      headers: authHeaders,
      payload: {
        areaId: area.id,
        subjectIds: [subject.id],
        curriculum: "BANGLA_MEDIUM",
        levelCode: 10,
        timeOfDay: "10:00",
        daysPerWeek: 3,
        salary: 5000,
        hireByDate: "2024-12-31",
        tuitionType: "Home Tutoring Solo",
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().message).toBe("Student profile not found");
  });

  it("should not allow creating with bad area ID", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    const subject = await createSubject();
    await createStudentProfile(account.id, area.id);
    const authHeaders = await getAuthHeaders(account);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/requirements/",
      headers: authHeaders,
      payload: {
        areaId: 999999,
        subjectIds: [subject.id],
        curriculum: "BANGLA_MEDIUM",
        levelCode: 10,
        timeOfDay: "10:00",
        daysPerWeek: 3,
        salary: 5000,
        hireByDate: "2024-12-31",
        tuitionType: "Home Tutoring Solo",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toBe("Invalid area or subject ID");
  });

  it("should not allow editing with bad area ID", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    const subject = await createSubject();
    const studentProfile = await createStudentProfile(account.id, area.id);
    const authHeaders = await getAuthHeaders(account);

    const requirement = await createRequirement({
      studentId: studentProfile.id,
      areaId: area.id,
      subjectId: subject.id,
    });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/requirements/${requirement.id}`,
      headers: authHeaders,
      payload: {
        areaId: 999999,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toBe("Invalid area or subject ID");
  });

  it("should not allow creating with an inactive area", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    const inactive = await createArea({ isActive: false });
    const subject = await createSubject();
    await createStudentProfile(account.id, area.id);
    const authHeaders = await getAuthHeaders(account);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/requirements/",
      headers: authHeaders,
      payload: {
        areaId: inactive.id,
        subjectIds: [subject.id],
        curriculum: "BANGLA_MEDIUM",
        levelCode: 10,
        timeOfDay: "10:00",
        daysPerWeek: 3,
        salary: 5000,
        hireByDate: "2024-12-31",
        tuitionType: "Home Tutoring Solo",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toBe("Invalid area or subject ID");
  });

  it("should not allow editing to an inactive area", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    const inactive = await createArea({ isActive: false });
    const subject = await createSubject();
    const studentProfile = await createStudentProfile(account.id, area.id);
    const authHeaders = await getAuthHeaders(account);

    const requirement = await createRequirement({
      studentId: studentProfile.id,
      areaId: area.id,
      subjectId: subject.id,
    });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/requirements/${requirement.id}`,
      headers: authHeaders,
      payload: {
        areaId: inactive.id,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toBe("Invalid area or subject ID");
  });

  it("should allow editing other fields when the saved area was deactivated", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    const subject = await createSubject();
    const studentProfile = await createStudentProfile(account.id, area.id);
    const authHeaders = await getAuthHeaders(account);

    const requirement = await createRequirement({
      studentId: studentProfile.id,
      areaId: area.id,
      subjectId: subject.id,
    });
    await prisma.area.update({ where: { id: area.id }, data: { isActive: false } });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/requirements/${requirement.id}`,
      headers: authHeaders,
      payload: {
        salary: 6000,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().salary).toBe(6000);
    expect(response.json().areaId).toBe(area.id);
  });

  it("should reject requirement creation with invalid tuitionType", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    const subject = await createSubject();
    await createStudentProfile(account.id, area.id);
    const authHeaders = await getAuthHeaders(account);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/requirements/",
      headers: authHeaders,
      payload: {
        areaId: area.id,
        subjectIds: [subject.id],
        curriculum: "BANGLA_MEDIUM",
        levelCode: 10,
        timeOfDay: "10:00",
        daysPerWeek: 3,
        salary: 5000,
        hireByDate: "2024-12-31",
        tuitionType: "InvalidType",
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it("should reject requirement creation with levelCode above 13", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    const subject = await createSubject();
    await createStudentProfile(account.id, area.id);
    const authHeaders = await getAuthHeaders(account);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/requirements/",
      headers: authHeaders,
      payload: {
        areaId: area.id,
        subjectIds: [subject.id],
        curriculum: "BANGLA_MEDIUM",
        levelCode: 20,
        timeOfDay: "10:00",
        daysPerWeek: 3,
        salary: 5000,
        hireByDate: "2024-12-31",
        tuitionType: "Home Tutoring Solo",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("VALIDATION_ERROR");
  });

  it("should accept levelCode 0 for MADRASAH and echo it back", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    const subject = await createSubject();
    await createStudentProfile(account.id, area.id);
    const authHeaders = await getAuthHeaders(account);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/requirements/",
      headers: authHeaders,
      payload: {
        areaId: area.id,
        subjectIds: [subject.id],
        curriculum: "MADRASAH",
        levelCode: 0,
        timeOfDay: "10:00",
        daysPerWeek: 3,
        salary: 5000,
        hireByDate: "2024-12-31",
        tuitionType: "Home Tutoring Solo",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().levelCode).toBe(0);
    expect(response.json().curriculum).toBe("MADRASAH");
  });

  it("should reject levelCode below the minimum", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    const subject = await createSubject();
    await createStudentProfile(account.id, area.id);
    const authHeaders = await getAuthHeaders(account);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/requirements/",
      headers: authHeaders,
      payload: {
        areaId: area.id,
        subjectIds: [subject.id],
        curriculum: "MADRASAH",
        levelCode: -5,
        timeOfDay: "10:00",
        daysPerWeek: 3,
        salary: 5000,
        hireByDate: "2024-12-31",
        tuitionType: "Home Tutoring Solo",
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it("should not coerce an empty-string levelCode into 0", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    const subject = await createSubject();
    await createStudentProfile(account.id, area.id);
    const authHeaders = await getAuthHeaders(account);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/requirements/",
      headers: authHeaders,
      payload: {
        areaId: area.id,
        subjectIds: [subject.id],
        curriculum: "MADRASAH",
        levelCode: "",
        timeOfDay: "10:00",
        daysPerWeek: 3,
        salary: 5000,
        hireByDate: "2024-12-31",
        tuitionType: "Home Tutoring Solo",
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it("should reject an academic group at a level outside 9 to 12", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    const subject = await createSubject();
    await createStudentProfile(account.id, area.id);
    const authHeaders = await getAuthHeaders(account);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/requirements/",
      headers: authHeaders,
      payload: {
        areaId: area.id,
        subjectIds: [subject.id],
        curriculum: "BANGLA_MEDIUM",
        levelCode: 8,
        academicGroup: "SCIENCE",
        timeOfDay: "10:00",
        daysPerWeek: 3,
        salary: 5000,
        hireByDate: "2024-12-31",
        tuitionType: "Home Tutoring Solo",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("VALIDATION_ERROR");
    expect(response.json().issues).toContainEqual(
      expect.objectContaining({ path: ["academicGroup"] }),
    );
  });

  it("should reject a group that the curriculum does not offer", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    const subject = await createSubject();
    await createStudentProfile(account.id, area.id);
    const authHeaders = await getAuthHeaders(account);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/requirements/",
      headers: authHeaders,
      payload: {
        areaId: area.id,
        subjectIds: [subject.id],
        curriculum: "BANGLA_MEDIUM",
        levelCode: 10,
        academicGroup: "MUJABBID",
        timeOfDay: "10:00",
        daysPerWeek: 3,
        salary: 5000,
        hireByDate: "2024-12-31",
        tuitionType: "Home Tutoring Solo",
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it("should allow admission targets only at level 13", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    const subject = await createSubject();
    await createStudentProfile(account.id, area.id);
    const authHeaders = await getAuthHeaders(account);

    const base = {
      areaId: area.id,
      subjectIds: [subject.id],
      curriculum: "BANGLA_MEDIUM",
      admissionTargets: ["MEDICAL"],
      timeOfDay: "10:00",
      daysPerWeek: 3,
      salary: 5000,
      hireByDate: "2024-12-31",
      tuitionType: "Home Tutoring Solo",
    };

    const atLevel12 = await app.inject({
      method: "POST",
      url: "/api/v1/requirements/",
      headers: authHeaders,
      payload: { ...base, levelCode: 12 },
    });
    expect(atLevel12.statusCode).toBe(400);

    const atLevel13 = await app.inject({
      method: "POST",
      url: "/api/v1/requirements/",
      headers: authHeaders,
      payload: { ...base, levelCode: 13 },
    });
    expect(atLevel13.statusCode).toBe(201);
    expect(atLevel13.json().admissionTargets).toEqual(["MEDICAL"]);
  });

  it("should allow retaking only at levels 10, 12 and 13", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    const subject = await createSubject();
    await createStudentProfile(account.id, area.id);
    const authHeaders = await getAuthHeaders(account);

    const base = {
      areaId: area.id,
      subjectIds: [subject.id],
      curriculum: "BANGLA_MEDIUM",
      isRetaker: true,
      timeOfDay: "10:00",
      daysPerWeek: 3,
      salary: 5000,
      hireByDate: "2024-12-31",
      tuitionType: "Home Tutoring Solo",
    };

    const atLevel11 = await app.inject({
      method: "POST",
      url: "/api/v1/requirements/",
      headers: authHeaders,
      payload: { ...base, levelCode: 11 },
    });
    expect(atLevel11.statusCode).toBe(400);

    const atLevel12 = await app.inject({
      method: "POST",
      url: "/api/v1/requirements/",
      headers: authHeaders,
      payload: { ...base, levelCode: 12 },
    });
    expect(atLevel12.statusCode).toBe(201);
    expect(atLevel12.json().isRetaker).toBe(true);
  });

  it("should trim and collapse whitespace in levelNote", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    const subject = await createSubject();
    await createStudentProfile(account.id, area.id);
    const authHeaders = await getAuthHeaders(account);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/requirements/",
      headers: authHeaders,
      payload: {
        areaId: area.id,
        subjectIds: [subject.id],
        curriculum: "BANGLA_MEDIUM",
        levelCode: 10,
        levelNote: "  hello   world  ",
        timeOfDay: "10:00",
        daysPerWeek: 3,
        salary: 5000,
        hireByDate: "2024-12-31",
        tuitionType: "Home Tutoring Solo",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().levelNote).toBe("hello world");
  });

  it("should reject a levelNote longer than 40 characters", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    const subject = await createSubject();
    await createStudentProfile(account.id, area.id);
    const authHeaders = await getAuthHeaders(account);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/requirements/",
      headers: authHeaders,
      payload: {
        areaId: area.id,
        subjectIds: [subject.id],
        curriculum: "BANGLA_MEDIUM",
        levelCode: 10,
        levelNote: "a".repeat(41),
        timeOfDay: "10:00",
        daysPerWeek: 3,
        salary: 5000,
        hireByDate: "2024-12-31",
        tuitionType: "Home Tutoring Solo",
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it("should reject a PATCH that makes the stored group invalid for a new curriculum", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    const subject = await createSubject();
    const studentProfile = await createStudentProfile(account.id, area.id);
    const authHeaders = await getAuthHeaders(account);

    const requirement = await createRequirement({
      studentId: studentProfile.id,
      areaId: area.id,
      subjectId: subject.id,
      levelCode: 10,
      curriculum: "BANGLA_MEDIUM",
      academicGroup: "SCIENCE",
    });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/requirements/${requirement.id}`,
      headers: authHeaders,
      payload: { curriculum: "EM_CAMBRIDGE" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("INVALID_REQUIREMENT");
  });

  it("should clear the academic group when PATCHed with null", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    const subject = await createSubject();
    const studentProfile = await createStudentProfile(account.id, area.id);
    const authHeaders = await getAuthHeaders(account);

    const requirement = await createRequirement({
      studentId: studentProfile.id,
      areaId: area.id,
      subjectId: subject.id,
      levelCode: 10,
      curriculum: "BANGLA_MEDIUM",
      academicGroup: "SCIENCE",
    });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/requirements/${requirement.id}`,
      headers: authHeaders,
      payload: { academicGroup: null },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().academicGroup).toBeNull();
  });

  it("should allow creating an incomplete requirement with status DRAFT", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    await createStudentProfile(account.id, area.id);
    const authHeaders = await getAuthHeaders(account);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/requirements/",
      headers: authHeaders,
      payload: {
        status: "DRAFT",
        salary: 7000,
        tuitionType: "Online",
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.status).toBe("DRAFT");
    expect(body.salary).toBe(7000);
    expect(body.tuitionType).toBe("Online");
    expect(body.curriculum).toBeNull();
    expect(body.levelCode).toBeNull();
    expect(body.areaId).toBeNull();
    expect(body.subjectIds).toEqual([]);
    expect(body.timeOfDay).toBeNull();
    expect(body.hireByDate).toBeNull();
    expect(body.daysPerWeek).toBeNull();
  });

  it("should allow creating a draft with only curriculum set", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    await createStudentProfile(account.id, area.id);
    const authHeaders = await getAuthHeaders(account);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/requirements/",
      headers: authHeaders,
      payload: {
        status: "DRAFT",
        curriculum: "BANGLA_MEDIUM",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().curriculum).toBe("BANGLA_MEDIUM");
    expect(response.json().levelCode).toBeNull();
  });

  it("should allow creating an empty draft requirement with only status DRAFT", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    await createStudentProfile(account.id, area.id);
    const authHeaders = await getAuthHeaders(account);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/requirements/",
      headers: authHeaders,
      payload: {
        status: "DRAFT",
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.status).toBe("DRAFT");
    expect(body.salary).toBeNull();
  });

  it("should reject creating incomplete requirement when status is OPEN or omitted", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    await createStudentProfile(account.id, area.id);
    const authHeaders = await getAuthHeaders(account);

    // Omitted status defaults to OPEN
    const res1 = await app.inject({
      method: "POST",
      url: "/api/v1/requirements/",
      headers: authHeaders,
      payload: {
        salary: 5000,
      },
    });
    expect(res1.statusCode).toBe(400);

    // Explicit status OPEN
    const res2 = await app.inject({
      method: "POST",
      url: "/api/v1/requirements/",
      headers: authHeaders,
      payload: {
        status: "OPEN",
        salary: 5000,
      },
    });
    expect(res2.statusCode).toBe(400);
  });

  it("should not allow publishing an incomplete draft directly to OPEN", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    await createStudentProfile(account.id, area.id);
    const authHeaders = await getAuthHeaders(account);

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/requirements/",
      headers: authHeaders,
      payload: {
        status: "DRAFT",
        salary: 5000,
      },
    });
    expect(createRes.statusCode).toBe(201);
    const createdId = createRes.json().id;

    const patchRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/requirements/${createdId}`,
      headers: authHeaders,
      payload: {
        status: "OPEN",
      },
    });

    expect(patchRes.statusCode).toBe(400);
    expect(patchRes.json().message).toBe(
      "Cannot publish incomplete requirement: all fields are required to open",
    );
  });

  it("should allow completing and publishing a draft to OPEN", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    const subject = await createSubject();
    await createStudentProfile(account.id, area.id);
    const authHeaders = await getAuthHeaders(account);

    // Start as incomplete draft
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/requirements/",
      headers: authHeaders,
      payload: {
        status: "DRAFT",
        curriculum: "BANGLA_MEDIUM",
        salary: 6000,
      },
    });
    expect(createRes.statusCode).toBe(201);
    const createdId = createRes.json().id;

    // Provide remaining required fields and publish to OPEN
    const patchRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/requirements/${createdId}`,
      headers: authHeaders,
      payload: {
        areaId: area.id,
        subjectIds: [subject.id],
        levelCode: 8,
        timeOfDay: "16:00",
        daysPerWeek: 4,
        hireByDate: "2025-01-15",
        tuitionType: "Online",
        status: "OPEN",
      },
    });

    expect(patchRes.statusCode).toBe(200);
    const body = patchRes.json();
    expect(body.status).toBe("OPEN");
    expect(body.salary).toBe(6000);
    expect(body.curriculum).toBe("BANGLA_MEDIUM");
    expect(body.levelCode).toBe(8);
    expect(body.tuitionType).toBe("Online");
  });

  it("should save multiple subjects on a draft and return them on GET", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    const first = await createSubject();
    const second = await createSubject();
    await createStudentProfile(account.id, area.id);
    const authHeaders = await getAuthHeaders(account);

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/requirements/",
      headers: authHeaders,
      payload: {
        status: "DRAFT",
        curriculum: "BANGLA_MEDIUM",
        subjectIds: [second.id, first.id],
      },
    });
    expect(createRes.statusCode).toBe(201);
    expect(sorted(createRes.json().subjectIds)).toEqual(sorted([first.id, second.id]));

    const getRes = await app.inject({
      method: "GET",
      url: `/api/v1/requirements/${createRes.json().id}`,
      headers: authHeaders,
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().subjectIds).toEqual(sorted([first.id, second.id]));
  });

  it("should replace subjects on a draft when it is edited", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    const first = await createSubject();
    const second = await createSubject();
    const studentProfile = await createStudentProfile(account.id, area.id);
    const authHeaders = await getAuthHeaders(account);

    const requirement = await createRequirement({
      studentId: studentProfile.id,
      areaId: area.id,
      subjectIds: [first.id],
      status: "DRAFT",
    });

    const addRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/requirements/${requirement.id}`,
      headers: authHeaders,
      payload: { subjectIds: [first.id, second.id] },
    });
    expect(addRes.statusCode).toBe(200);
    expect(sorted(addRes.json().subjectIds)).toEqual(sorted([first.id, second.id]));

    const removeRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/requirements/${requirement.id}`,
      headers: authHeaders,
      payload: { subjectIds: [second.id] },
    });
    expect(removeRes.statusCode).toBe(200);

    const getRes = await app.inject({
      method: "GET",
      url: `/api/v1/requirements/${requirement.id}`,
      headers: authHeaders,
    });
    expect(getRes.json().subjectIds).toEqual([second.id]);
  });

  it("should keep existing subjects when a draft is edited without subjectIds", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    const first = await createSubject();
    const second = await createSubject();
    const studentProfile = await createStudentProfile(account.id, area.id);
    const authHeaders = await getAuthHeaders(account);

    const requirement = await createRequirement({
      studentId: studentProfile.id,
      areaId: area.id,
      subjectIds: [first.id, second.id],
      status: "DRAFT",
    });

    const patchRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/requirements/${requirement.id}`,
      headers: authHeaders,
      payload: { salary: 9000 },
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json().salary).toBe(9000);
    expect(sorted(patchRes.json().subjectIds)).toEqual(sorted([first.id, second.id]));
  });

  it("should allow creating a draft with no subjects", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    await createStudentProfile(account.id, area.id);
    const authHeaders = await getAuthHeaders(account);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/requirements/",
      headers: authHeaders,
      payload: { status: "DRAFT", curriculum: "BANGLA_MEDIUM", subjectIds: [] },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().subjectIds).toEqual([]);
  });

  it("should clear all subjects from a draft", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    const subject = await createSubject();
    const studentProfile = await createStudentProfile(account.id, area.id);
    const authHeaders = await getAuthHeaders(account);

    const requirement = await createRequirement({
      studentId: studentProfile.id,
      areaId: area.id,
      subjectIds: [subject.id],
      status: "DRAFT",
    });

    const patchRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/requirements/${requirement.id}`,
      headers: authHeaders,
      payload: { subjectIds: [] },
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json().subjectIds).toEqual([]);

    const getRes = await app.inject({
      method: "GET",
      url: `/api/v1/requirements/${requirement.id}`,
      headers: authHeaders,
    });
    expect(getRes.json().subjectIds).toEqual([]);
  });

  it("should reject publishing a requirement that has no subjects", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    const subject = await createSubject();
    const studentProfile = await createStudentProfile(account.id, area.id);
    const authHeaders = await getAuthHeaders(account);

    const requirement = await createRequirement({
      studentId: studentProfile.id,
      areaId: area.id,
      subjectIds: [subject.id],
      status: "DRAFT",
    });

    const patchRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/requirements/${requirement.id}`,
      headers: authHeaders,
      payload: { subjectIds: [], status: "OPEN" },
    });
    expect(patchRes.statusCode).toBe(400);
    expect(patchRes.json().message).toBe(
      "Cannot publish incomplete requirement: all fields are required to open",
    );

    const getRes = await app.inject({
      method: "GET",
      url: `/api/v1/requirements/${requirement.id}`,
      headers: authHeaders,
    });
    expect(getRes.json().subjectIds).toEqual([subject.id]);
  });

  it("should reject creating an OPEN requirement with no subjects", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    await createStudentProfile(account.id, area.id);
    const authHeaders = await getAuthHeaders(account);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/requirements/",
      headers: authHeaders,
      payload: {
        areaId: area.id,
        subjectIds: [],
        curriculum: "BANGLA_MEDIUM",
        levelCode: 10,
        timeOfDay: "10:00",
        daysPerWeek: 3,
        salary: 5000,
        hireByDate: "2024-12-31",
        tuitionType: "Home Tutoring Solo",
      },
    });

    expect(response.statusCode).toBe(400);
  });

  describe("availableDays and daysPerWeek", () => {
    const openPayload = (
      areaId: number,
      subjectId: number,
      overrides: Record<string, unknown> = {},
    ) => ({
      areaId,
      subjectIds: [subjectId],
      curriculum: "BANGLA_MEDIUM",
      levelCode: 10,
      timeOfDay: "10:00",
      daysPerWeek: 3,
      salary: 5000,
      hireByDate: "2024-12-31",
      tuitionType: "Home Tutoring Solo",
      ...overrides,
    });

    it("stores and returns the availableDays mask", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "STUDENT" });
      const area = await createArea();
      const subject = await createSubject();
      await createStudentProfile(account.id, area.id);
      const authHeaders = await getAuthHeaders(account);

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/requirements/",
        headers: authHeaders,
        payload: openPayload(area.id, subject.id, { availableDays: 0b0010101 }),
      });

      expect(response.statusCode).toBe(201);
      expect(response.json().availableDays).toBe(21);
    });

    it("defaults availableDays to every day when omitted", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "STUDENT" });
      const area = await createArea();
      const subject = await createSubject();
      await createStudentProfile(account.id, area.id);
      const authHeaders = await getAuthHeaders(account);

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/requirements/",
        headers: authHeaders,
        payload: openPayload(area.id, subject.id),
      });

      expect(response.statusCode).toBe(201);
      expect(response.json().availableDays).toBe(127);
    });

    it("rejects a daysPerWeek larger than the number of available days", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "STUDENT" });
      const area = await createArea();
      const subject = await createSubject();
      await createStudentProfile(account.id, area.id);
      const authHeaders = await getAuthHeaders(account);

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/requirements/",
        headers: authHeaders,
        payload: openPayload(area.id, subject.id, { daysPerWeek: 5, availableDays: 3 }),
      });

      expect(response.statusCode).toBe(400);
    });

    it("rejects a PATCH that leaves daysPerWeek above the available days", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "STUDENT" });
      const area = await createArea();
      const subject = await createSubject();
      const studentProfile = await createStudentProfile(account.id, area.id);
      const authHeaders = await getAuthHeaders(account);
      const requirement = await createRequirement({
        studentId: studentProfile.id,
        areaId: area.id,
        subjectId: subject.id,
        daysPerWeek: 3,
      });

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/requirements/${requirement.id}`,
        headers: authHeaders,
        payload: { availableDays: 1 },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe("INVALID_REQUIREMENT");
    });

    it("accepts a PATCH that sets availableDays and daysPerWeek together", async () => {
      const app = await createTestApp();
      const account = await createAccount({ role: "STUDENT" });
      const area = await createArea();
      const subject = await createSubject();
      const studentProfile = await createStudentProfile(account.id, area.id);
      const authHeaders = await getAuthHeaders(account);
      const requirement = await createRequirement({
        studentId: studentProfile.id,
        areaId: area.id,
        subjectId: subject.id,
        daysPerWeek: 3,
      });

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/requirements/${requirement.id}`,
        headers: authHeaders,
        payload: { availableDays: 7, daysPerWeek: 2 },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ availableDays: 7, daysPerWeek: 2 });
    });
  });
});

describe("student phone verification gate on requirements", () => {
  beforeEach(async () => {
    await setPlatformSetting("require_student_phone_verification", true);
    await setPlatformSetting("require_tutor_phone_verification", false);
  });

  const openPayload = (areaId: number, subjectId: number) => ({
    areaId,
    subjectIds: [subjectId],
    curriculum: "BANGLA_MEDIUM",
    levelCode: 10,
    timeOfDay: "10:00",
    daysPerWeek: 3,
    salary: 5000,
    hireByDate: "2024-12-31",
    tuitionType: "Home Tutoring Solo",
  });

  async function unverifiedStudent() {
    const account = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    const subject = await createSubject();
    const student = await createStudentProfile(account.id, area.id);
    return { account, area, subject, student, headers: await getAuthHeaders(account) };
  }

  it("refuses to create an OPEN requirement until the phone is verified", async () => {
    const app = await createTestApp();
    const { area, subject, student, headers } = await unverifiedStudent();

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/requirements/",
      headers,
      payload: openPayload(area.id, subject.id),
    });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe("PHONE_VERIFICATION_REQUIRED");
    expect(await prisma.tuitionRequirement.count({ where: { studentId: student.id } })).toBe(0);
  });

  it("allows creating a DRAFT requirement before the phone is verified", async () => {
    const app = await createTestApp();
    const { area, subject, headers } = await unverifiedStudent();

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/requirements/",
      headers,
      payload: { status: "DRAFT", areaId: area.id, subjectIds: [subject.id] },
    });

    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).status).toBe("DRAFT");
  });

  it("refuses publishing a DRAFT (DRAFT -> OPEN) until the phone is verified", async () => {
    const app = await createTestApp();
    const { area, subject, student, headers } = await unverifiedStudent();
    const requirement = await createRequirement({
      studentId: student.id,
      areaId: area.id,
      subjectId: subject.id,
      status: "DRAFT",
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/requirements/${requirement.id}`,
      headers,
      payload: { status: "OPEN" },
    });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe("PHONE_VERIFICATION_REQUIRED");
    const row = await prisma.tuitionRequirement.findUniqueOrThrow({
      where: { id: requirement.id },
    });
    expect(row.status).toBe("DRAFT");
  });

  it("still allows editing a requirement that is already OPEN", async () => {
    const app = await createTestApp();
    const { area, subject, student, headers } = await unverifiedStudent();
    const requirement = await createRequirement({
      studentId: student.id,
      areaId: area.id,
      subjectId: subject.id,
      status: "OPEN",
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/requirements/${requirement.id}`,
      headers,
      payload: { salary: 6000 },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).salary).toBe(6000);
  });

  it("lets a verified student create and publish", async () => {
    const app = await createTestApp();
    const { area, subject, student, headers } = await unverifiedStudent();
    await prisma.student.update({
      where: { id: student.id },
      data: { phoneVerifiedAt: new Date() },
    });
    // Level 11, not 10: an identical draft would be a duplicate of the OPEN post below.
    const draft = await createRequirement({
      studentId: student.id,
      areaId: area.id,
      subjectId: subject.id,
      levelCode: 11,
      status: "DRAFT",
    });

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/requirements/",
      headers,
      payload: openPayload(area.id, subject.id),
    });
    expect(created.statusCode).toBe(201);

    const published = await app.inject({
      method: "PATCH",
      url: `/api/v1/requirements/${draft.id}`,
      headers,
      payload: { status: "OPEN" },
    });
    expect(published.statusCode).toBe(200);
    expect(JSON.parse(published.body).status).toBe("OPEN");
  });

  it("does not gate students when the switch is off", async () => {
    await setPlatformSetting("require_student_phone_verification", false);
    const app = await createTestApp();
    const { area, subject, headers } = await unverifiedStudent();

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/requirements/",
      headers,
      payload: openPayload(area.id, subject.id),
    });

    expect(res.statusCode).toBe(201);
  });
});

type HireStatus = "PENDING" | "CONFIRMED" | "COMPLETED" | "REJECTED" | "WITHDRAWN" | "CANCELLED";
type TestApp = Awaited<ReturnType<typeof createTestApp>>;
type TestHeaders = Awaited<ReturnType<typeof getAuthHeaders>>;

async function applyFromTutor(requirementId: string, studentId: string, status: HireStatus) {
  const tutorAccount = await createAccount({ role: "TUTOR" });
  const tutor = await createTutorProfile(tutorAccount.id);
  return createApplication({
    requirementId,
    studentId,
    tutorId: tutor.id,
    initiatedBy: "TUTOR",
    status,
  });
}

async function postRequirement(app: TestApp, headers: TestHeaders, payload: object) {
  return app.inject({ method: "POST", url: "/api/v1/requirements/", headers, payload });
}

describe("FILLED is derived from hires", () => {
  async function studentWithRequirement(stored: "OPEN" | "CLOSED" = "OPEN") {
    const app = await createTestApp();
    const account = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    const subject = await createSubject();
    const student = await createStudentProfile(account.id, area.id);
    const requirement = await createRequirement({
      studentId: student.id,
      areaId: area.id,
      subjectId: subject.id,
      status: stored,
    });
    return { app, student, requirement, headers: await getAuthHeaders(account) };
  }

  it.each(["CONFIRMED", "COMPLETED"] as const)(
    "reads FILLED on /mine and /:id with a %s application",
    async (status) => {
      const { app, student, requirement, headers } = await studentWithRequirement();
      await applyFromTutor(requirement.id, student.id, status);

      const mine = await app.inject({ method: "GET", url: "/api/v1/requirements/mine", headers });
      expect(mine.statusCode).toBe(200);
      const listed = mine.json().requirements[0];
      expect(listed.status).toBe("FILLED");
      expect(listed).not.toHaveProperty("_count");

      const one = await app.inject({
        method: "GET",
        url: `/api/v1/requirements/${requirement.id}`,
        headers,
      });
      expect(one.statusCode).toBe(200);
      expect(one.json().status).toBe("FILLED");
      expect(one.json()).not.toHaveProperty("_count");
    },
  );

  it("goes back to OPEN when the hire is cancelled", async () => {
    const { app, student, requirement, headers } = await studentWithRequirement();
    const application = await applyFromTutor(requirement.id, student.id, "CONFIRMED");
    await prisma.application.update({
      where: { id: application.id },
      data: { status: "CANCELLED" },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/requirements/${requirement.id}`,
      headers,
    });
    expect(res.json().status).toBe("OPEN");
  });

  it("reads FILLED over a stored CLOSED status when a hire exists", async () => {
    const { app, student, requirement, headers } = await studentWithRequirement("CLOSED");
    await applyFromTutor(requirement.id, student.id, "CONFIRMED");

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/requirements/${requirement.id}`,
      headers,
    });
    expect(res.json().status).toBe("FILLED");
  });

  it("keeps the stored status when no application is a hire", async () => {
    const { app, student, requirement, headers } = await studentWithRequirement();
    await applyFromTutor(requirement.id, student.id, "PENDING");
    await applyFromTutor(requirement.id, student.id, "REJECTED");
    await applyFromTutor(requirement.id, student.id, "WITHDRAWN");

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/requirements/${requirement.id}`,
      headers,
    });
    expect(res.json().status).toBe("OPEN");
  });
});

describe("editing a hired requirement", () => {
  it("returns 409 for a PATCH until the hire is cancelled, then allows it", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    const subject = await createSubject();
    const student = await createStudentProfile(account.id, area.id);
    const headers = await getAuthHeaders(account);
    const requirement = await createRequirement({
      studentId: student.id,
      areaId: area.id,
      subjectId: subject.id,
    });
    const application = await applyFromTutor(requirement.id, student.id, "CONFIRMED");

    const blocked = await app.inject({
      method: "PATCH",
      url: `/api/v1/requirements/${requirement.id}`,
      headers,
      payload: { salary: 6000 },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().message).toContain("Cannot modify requirement");
    const unchanged = await prisma.tuitionRequirement.findUniqueOrThrow({
      where: { id: requirement.id },
    });
    expect(unchanged.salary).toBe(5000);

    await prisma.application.update({
      where: { id: application.id },
      data: { status: "CANCELLED" },
    });

    const allowed = await app.inject({
      method: "PATCH",
      url: `/api/v1/requirements/${requirement.id}`,
      headers,
      payload: { salary: 6000 },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().salary).toBe(6000);
  });

  it("still allows closing a hired requirement, and reports it as FILLED", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    const subject = await createSubject();
    const student = await createStudentProfile(account.id, area.id);
    const headers = await getAuthHeaders(account);
    const requirement = await createRequirement({
      studentId: student.id,
      areaId: area.id,
      subjectId: subject.id,
    });
    await applyFromTutor(requirement.id, student.id, "CONFIRMED");

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/requirements/${requirement.id}/close`,
      headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("FILLED");

    const stored = await prisma.tuitionRequirement.findUniqueOrThrow({
      where: { id: requirement.id },
    });
    expect(stored.status).toBe("CLOSED");
  });
});

describe("duplicate open requirements", () => {
  const openPayload = (areaId: number, subjectIds: number[], overrides: object = {}) => ({
    areaId,
    subjectIds,
    curriculum: "BANGLA_MEDIUM",
    levelCode: 10,
    academicGroup: "SCIENCE",
    timeOfDay: "10:00",
    daysPerWeek: 3,
    salary: 5000,
    hireByDate: "2024-12-31",
    tuitionType: "Home Tutoring Solo",
    ...overrides,
  });

  async function studentSetup() {
    const app = await createTestApp();
    const account = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    const subject = await createSubject();
    const otherSubject = await createSubject();
    const student = await createStudentProfile(account.id, area.id);
    return {
      app,
      area,
      subject,
      otherSubject,
      student,
      headers: await getAuthHeaders(account),
    };
  }

  it("rejects an identical second post with REQUIREMENT_DUPLICATE", async () => {
    const { app, area, subject, headers } = await studentSetup();
    const first = await postRequirement(app, headers, openPayload(area.id, [subject.id]));
    expect(first.statusCode).toBe(201);

    const second = await postRequirement(app, headers, openPayload(area.id, [subject.id]));
    expect(second.statusCode).toBe(409);
    const body = JSON.parse(second.body);
    expect(body.code).toBe("REQUIREMENT_DUPLICATE");
    expect(body.error).toBe("RequirementDuplicate");
    expect(body.details.requirementId).toBe(first.json().id);
  });

  it("treats the same subjects in a different order as a duplicate", async () => {
    const { app, area, subject, otherSubject, headers } = await studentSetup();
    const first = await postRequirement(
      app,
      headers,
      openPayload(area.id, [subject.id, otherSubject.id]),
    );
    expect(first.statusCode).toBe(201);

    const second = await postRequirement(
      app,
      headers,
      openPayload(area.id, [otherSubject.id, subject.id]),
    );
    expect(second.statusCode).toBe(409);
    expect(JSON.parse(second.body).code).toBe("REQUIREMENT_DUPLICATE");
  });

  it.each([
    ["levelCode", { levelCode: 11 }],
    ["curriculum", { curriculum: "ENGLISH_VERSION" }],
    ["academicGroup", { academicGroup: "HUMANITIES" }],
  ])("allows a post that differs only in %s", async (_field, change) => {
    const { app, area, subject, headers } = await studentSetup();
    const first = await postRequirement(app, headers, openPayload(area.id, [subject.id]));
    expect(first.statusCode).toBe(201);

    const second = await postRequirement(app, headers, openPayload(area.id, [subject.id], change));
    expect(second.statusCode).toBe(201);
  });

  it("allows a post that differs only in area", async () => {
    const { app, area, subject, headers } = await studentSetup();
    const otherArea = await createArea();
    const first = await postRequirement(app, headers, openPayload(area.id, [subject.id]));
    expect(first.statusCode).toBe(201);

    const second = await postRequirement(app, headers, openPayload(otherArea.id, [subject.id]));
    expect(second.statusCode).toBe(201);
  });

  it("allows a post whose subject set differs", async () => {
    const { app, area, subject, otherSubject, headers } = await studentSetup();
    const first = await postRequirement(app, headers, openPayload(area.id, [subject.id]));
    expect(first.statusCode).toBe(201);

    const second = await postRequirement(
      app,
      headers,
      openPayload(area.id, [subject.id, otherSubject.id]),
    );
    expect(second.statusCode).toBe(201);
  });

  it("compares admission targets as a set at level 13", async () => {
    const { app, area, subject, headers } = await studentSetup();
    const atLevel13 = {
      levelCode: 13,
      academicGroup: undefined,
      admissionTargets: ["MEDICAL"],
    };
    const first = await postRequirement(
      app,
      headers,
      openPayload(area.id, [subject.id], atLevel13),
    );
    expect(first.statusCode).toBe(201);

    const different = await postRequirement(
      app,
      headers,
      openPayload(area.id, [subject.id], { ...atLevel13, admissionTargets: ["ENGINEERING"] }),
    );
    expect(different.statusCode).toBe(201);

    const sameSet = await postRequirement(
      app,
      headers,
      openPayload(area.id, [subject.id], { ...atLevel13, admissionTargets: ["MEDICAL"] }),
    );
    expect(sameSet.statusCode).toBe(409);
  });

  it("ignores salary, time, days, tuition type and student count", async () => {
    const { app, area, subject, headers } = await studentSetup();
    const first = await postRequirement(app, headers, openPayload(area.id, [subject.id]));
    expect(first.statusCode).toBe(201);

    const second = await postRequirement(
      app,
      headers,
      openPayload(area.id, [subject.id], { salary: 9000 }),
    );
    expect(second.statusCode).toBe(409);
    expect(JSON.parse(second.body).code).toBe("REQUIREMENT_DUPLICATE");
  });

  it("does not count a CLOSED requirement", async () => {
    const { app, area, subject, student, headers } = await studentSetup();
    await createRequirement({
      studentId: student.id,
      areaId: area.id,
      subjectId: subject.id,
      levelCode: 10,
      curriculum: "BANGLA_MEDIUM",
      academicGroup: "SCIENCE",
      status: "CLOSED",
    });

    const res = await postRequirement(app, headers, openPayload(area.id, [subject.id]));
    expect(res.statusCode).toBe(201);
  });

  it("does not count a requirement that already has a hire", async () => {
    const { app, area, subject, student, headers } = await studentSetup();
    const hired = await createRequirement({
      studentId: student.id,
      areaId: area.id,
      subjectId: subject.id,
      levelCode: 10,
      curriculum: "BANGLA_MEDIUM",
      academicGroup: "SCIENCE",
    });
    await applyFromTutor(hired.id, student.id, "CONFIRMED");

    const res = await postRequirement(app, headers, openPayload(area.id, [subject.id]));
    expect(res.statusCode).toBe(201);
  });

  it("does not count another student's requirement", async () => {
    const { app, area, subject, headers } = await studentSetup();
    const otherAccount = await createAccount({ role: "STUDENT" });
    const otherStudent = await createStudentProfile(otherAccount.id, area.id);
    await createRequirement({
      studentId: otherStudent.id,
      areaId: area.id,
      subjectId: subject.id,
      levelCode: 10,
      curriculum: "BANGLA_MEDIUM",
      academicGroup: "SCIENCE",
    });

    const res = await postRequirement(app, headers, openPayload(area.id, [subject.id]));
    expect(res.statusCode).toBe(201);
  });

  it("never checks a draft, even one identical to an OPEN requirement", async () => {
    const { app, area, subject, headers } = await studentSetup();
    const open = await postRequirement(app, headers, openPayload(area.id, [subject.id]));
    expect(open.statusCode).toBe(201);

    const draft = await postRequirement(
      app,
      headers,
      openPayload(area.id, [subject.id], { status: "DRAFT" }),
    );
    expect(draft.statusCode).toBe(201);
  });

  it("rejects publishing a draft that matches an OPEN requirement", async () => {
    const { app, area, subject, student, headers } = await studentSetup();
    const open = await postRequirement(app, headers, openPayload(area.id, [subject.id]));
    expect(open.statusCode).toBe(201);
    const draft = await createRequirement({
      studentId: student.id,
      areaId: area.id,
      subjectId: subject.id,
      levelCode: 10,
      curriculum: "BANGLA_MEDIUM",
      academicGroup: "SCIENCE",
      status: "DRAFT",
    });

    const publish = await app.inject({
      method: "PATCH",
      url: `/api/v1/requirements/${draft.id}`,
      headers,
      payload: { status: "OPEN" },
    });
    expect(publish.statusCode).toBe(409);
    expect(JSON.parse(publish.body).details.requirementId).toBe(open.json().id);
    const stored = await prisma.tuitionRequirement.findUniqueOrThrow({
      where: { id: draft.id },
    });
    expect(stored.status).toBe("DRAFT");
  });

  it("rejects a PATCH that turns an OPEN requirement into a copy of another", async () => {
    const { app, area, subject, headers } = await studentSetup();
    const first = await postRequirement(app, headers, openPayload(area.id, [subject.id]));
    expect(first.statusCode).toBe(201);
    const second = await postRequirement(
      app,
      headers,
      openPayload(area.id, [subject.id], { levelCode: 11 }),
    );
    expect(second.statusCode).toBe(201);

    const patch = await app.inject({
      method: "PATCH",
      url: `/api/v1/requirements/${second.json().id}`,
      headers,
      payload: { levelCode: 10 },
    });
    expect(patch.statusCode).toBe(409);
    expect(JSON.parse(patch.body).details.requirementId).toBe(first.json().id);
  });

  it("allows a PATCH to an OPEN requirement that changes nothing that matters", async () => {
    const { app, area, subject, headers } = await studentSetup();
    const created = await postRequirement(app, headers, openPayload(area.id, [subject.id]));
    expect(created.statusCode).toBe(201);

    const patch = await app.inject({
      method: "PATCH",
      url: `/api/v1/requirements/${created.json().id}`,
      headers,
      payload: { salary: 5000 },
    });
    expect(patch.statusCode).toBe(200);
  });

  it("lets twins that already exist edit fields outside the match, but not change one into a twin", async () => {
    const { app, area, subject, otherSubject, headers } = await studentSetup();
    const first = await postRequirement(app, headers, openPayload(area.id, [subject.id]));
    const second = await postRequirement(
      app,
      headers,
      openPayload(area.id, [subject.id], { levelCode: 11 }),
    );
    expect([first.statusCode, second.statusCode]).toEqual([201, 201]);
    // Twins from before the guard existed.
    await prisma.tuitionRequirement.update({
      where: { id: second.json().id },
      data: { levelCode: 10 },
    });

    const salary = await app.inject({
      method: "PATCH",
      url: `/api/v1/requirements/${second.json().id}`,
      headers,
      payload: { salary: 7000, subjectIds: [subject.id] },
    });
    expect(salary.statusCode).toBe(200);

    const away = await app.inject({
      method: "PATCH",
      url: `/api/v1/requirements/${second.json().id}`,
      headers,
      payload: { subjectIds: [subject.id, otherSubject.id] },
    });
    expect(away.statusCode).toBe(200);
    const back = await app.inject({
      method: "PATCH",
      url: `/api/v1/requirements/${second.json().id}`,
      headers,
      payload: { subjectIds: [subject.id] },
    });
    expect(back.statusCode).toBe(409);
  });

  it("makes concurrent posts for one student wait on the student's lock", async () => {
    const { app, area, subject, student, headers } = await studentSetup();
    const payload = openPayload(area.id, [subject.id]);

    // Holds the lock every post for this student takes, so both posts queue behind it.
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`requirement:${student.id}`}))`;
      await released;
    });

    const posts = Promise.all([
      postRequirement(app, headers, payload),
      postRequirement(app, headers, payload),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    await holder;

    const [a, b] = await posts;
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    expect(await prisma.tuitionRequirement.count({ where: { studentId: student.id } })).toBe(1);
  });

  it("lets exactly one of two identical concurrent posts through", async () => {
    const { app, area, subject, student, headers } = await studentSetup();
    const payload = openPayload(area.id, [subject.id]);

    const [a, b] = await Promise.all([
      postRequirement(app, headers, payload),
      postRequirement(app, headers, payload),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    expect(await prisma.tuitionRequirement.count({ where: { studentId: student.id } })).toBe(1);
  });
});
