import { describe, expect, it } from "vitest";
import {
  createAccount,
  createArea,
  createCategory,
  createRequirement,
  createStudentProfile,
  createSubject,
  createTestApp,
  getAuthHeaders,
} from "../../tests/helpers.js";

describe("requirement module", () => {
  it("should create a requirement with defaults", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    const category = await createCategory();
    const subject = await createSubject();
    const studentProfile = await createStudentProfile(account.id, area.id);
    const authHeaders = await getAuthHeaders(account);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/requirements/",
      headers: authHeaders,
      payload: {
        categoryId: category.id,
        areaId: area.id,
        subjectId: subject.id,
        classLevel: 10,
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
    expect(body.categoryId).toBe(category.id);
    expect(body.areaId).toBe(area.id);
    expect(body.subjectId).toBe(subject.id);
    expect(body.classLevel).toBe(10);
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
    const category = await createCategory();
    const subject = await createSubject();
    await createStudentProfile(account.id, area.id);
    const authHeaders = await getAuthHeaders(account);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/requirements/",
      headers: authHeaders,
      payload: {
        categoryId: category.id,
        areaId: area.id,
        subjectId: subject.id,
        classLevel: 10,
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
    const category = await createCategory();
    const subject = await createSubject();
    const studentProfile = await createStudentProfile(account.id, area.id);
    const authHeaders = await getAuthHeaders(account);

    const requirement = await createRequirement({
      studentId: studentProfile.id,
      categoryId: category.id,
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
    const category = await createCategory();
    const subject = await createSubject();
    const studentProfile = await createStudentProfile(account.id, area.id);
    const authHeaders = await getAuthHeaders(account);

    const requirement = await createRequirement({
      studentId: studentProfile.id,
      categoryId: category.id,
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
    const category = await createCategory();
    const subject = await createSubject();
    const studentProfile = await createStudentProfile(account.id, area.id);
    const authHeaders = await getAuthHeaders(account);

    const requirement = await createRequirement({
      studentId: studentProfile.id,
      categoryId: category.id,
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
        classLevel: 11,
        salary: 6000,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.classLevel).toBe(11);
    expect(body.salary).toBe(6000);
    expect(body.studentCount).toBe(3);
    expect(body.tutorGenderPref).toBe("FEMALE");
  });

  it("should update a draft requirement to open", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    const category = await createCategory();
    const subject = await createSubject();
    const studentProfile = await createStudentProfile(account.id, area.id);
    const authHeaders = await getAuthHeaders(account);

    const requirement = await createRequirement({
      studentId: studentProfile.id,
      categoryId: category.id,
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
    const category = await createCategory();
    const subject = await createSubject();
    const studentProfile = await createStudentProfile(account.id, area.id);
    const authHeaders = await getAuthHeaders(account);

    const requirement = await createRequirement({
      studentId: studentProfile.id,
      categoryId: category.id,
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
    const category = await createCategory();
    const subject = await createSubject();
    const studentProfile = await createStudentProfile(account.id, area.id);
    const authHeaders = await getAuthHeaders(account);

    const requirement = await createRequirement({
      studentId: studentProfile.id,
      categoryId: category.id,
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
    const category = await createCategory();
    const subject = await createSubject();
    const studentProfile = await createStudentProfile(account.id, area.id);
    const authHeaders = await getAuthHeaders(account);

    const requirement = await createRequirement({
      studentId: studentProfile.id,
      categoryId: category.id,
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
    const category = await createCategory();
    const subject = await createSubject();
    await createStudentProfile(account.id, area.id);
    const authHeaders = await getAuthHeaders(account);

    const otherAccount = await createAccount({ role: "STUDENT" });
    const otherStudentProfile = await createStudentProfile(otherAccount.id, area.id);

    const requirement = await createRequirement({
      studentId: otherStudentProfile.id,
      categoryId: category.id,
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
    const category = await createCategory();
    const subject = await createSubject();
    await createStudentProfile(account.id, area.id);
    const authHeaders = await getAuthHeaders(account);

    const otherAccount = await createAccount({ role: "STUDENT" });
    const otherStudentProfile = await createStudentProfile(otherAccount.id, area.id);

    const requirement = await createRequirement({
      studentId: otherStudentProfile.id,
      categoryId: category.id,
      areaId: area.id,
      subjectId: subject.id,
    });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/requirements/${requirement.id}`,
      headers: authHeaders,
      payload: {
        classLevel: 11,
      },
    });

    expect(response.statusCode).toBe(404);
  });

  it("should not allow closing another student's requirement", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    const category = await createCategory();
    const subject = await createSubject();
    await createStudentProfile(account.id, area.id);
    const authHeaders = await getAuthHeaders(account);

    const otherAccount = await createAccount({ role: "STUDENT" });
    const otherStudentProfile = await createStudentProfile(otherAccount.id, area.id);

    const requirement = await createRequirement({
      studentId: otherStudentProfile.id,
      categoryId: category.id,
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
    const category = await createCategory();
    const subject = await createSubject();
    const authHeaders = await getAuthHeaders(account);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/requirements/",
      headers: authHeaders,
      payload: {
        categoryId: category.id,
        areaId: area.id,
        subjectId: subject.id,
        classLevel: 10,
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

  it("should not allow creating with bad category ID", async () => {
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
        categoryId: 999999,
        areaId: area.id,
        subjectId: subject.id,
        classLevel: 10,
        timeOfDay: "10:00",
        daysPerWeek: 3,
        salary: 5000,
        hireByDate: "2024-12-31",
        tuitionType: "Home Tutoring Solo",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toBe("Invalid category, area, or subject ID");
  });

  it("should not allow editing with bad category ID", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    const category = await createCategory();
    const subject = await createSubject();
    const studentProfile = await createStudentProfile(account.id, area.id);
    const authHeaders = await getAuthHeaders(account);

    const requirement = await createRequirement({
      studentId: studentProfile.id,
      categoryId: category.id,
      areaId: area.id,
      subjectId: subject.id,
    });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/requirements/${requirement.id}`,
      headers: authHeaders,
      payload: {
        categoryId: 999999,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toBe("Invalid category, area, or subject ID");
  });

  it("should reject requirement creation with invalid tuitionType", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    const category = await createCategory();
    const subject = await createSubject();
    await createStudentProfile(account.id, area.id);
    const authHeaders = await getAuthHeaders(account);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/requirements/",
      headers: authHeaders,
      payload: {
        categoryId: category.id,
        areaId: area.id,
        subjectId: subject.id,
        classLevel: 10,
        timeOfDay: "10:00",
        daysPerWeek: 3,
        salary: 5000,
        hireByDate: "2024-12-31",
        tuitionType: "InvalidType",
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it("should reject requirement creation with classLevel exceeding 17", async () => {
    const app = await createTestApp();
    const account = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    const category = await createCategory();
    const subject = await createSubject();
    await createStudentProfile(account.id, area.id);
    const authHeaders = await getAuthHeaders(account);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/requirements/",
      headers: authHeaders,
      payload: {
        categoryId: category.id,
        areaId: area.id,
        subjectId: subject.id,
        classLevel: 18,
        timeOfDay: "10:00",
        daysPerWeek: 3,
        salary: 5000,
        hireByDate: "2024-12-31",
        tuitionType: "Home Tutoring Solo",
      },
    });

    expect(response.statusCode).toBe(400);
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
    expect(body.categoryId).toBeNull();
    expect(body.areaId).toBeNull();
    expect(body.subjectId).toBeNull();
    expect(body.classLevel).toBeNull();
    expect(body.timeOfDay).toBeNull();
    expect(body.hireByDate).toBeNull();
    expect(body.daysPerWeek).toBeNull();
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
    const category = await createCategory();
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
        categoryId: category.id,
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
        subjectId: subject.id,
        classLevel: 8,
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
    expect(body.classLevel).toBe(8);
    expect(body.tuitionType).toBe("Online");
  });
});
