import { describe, expect, it } from "vitest";
import {
  createAccount,
  createArea,
  createRequirement,
  createStudentProfile,
  createSubject,
  createTestApp,
  getAuthHeaders,
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
});
