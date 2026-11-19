import { describe, expect, it } from "vitest";
import { prisma } from "../../lib/prisma.js";
import {
  createAccount,
  createApplication,
  createArea,
  createRequirement,
  createStudentProfile,
  createTestApp,
  createTutorProfile,
  getAuthHeaders,
} from "../../tests/helpers.js";
import { REVIEW_EDIT_WINDOW_DAYS } from "./review.service.js";

const BASE = "/api/v1/reviews";

type Status = "PENDING" | "CONFIRMED" | "COMPLETED";

// A student, a tutor and one application between them.
async function setup(status: Status = "CONFIRMED") {
  const studentAccount = await createAccount({ role: "STUDENT" });
  const tutorAccount = await createAccount({ role: "TUTOR" });
  const area = await createArea();
  const student = await createStudentProfile(studentAccount.id, area.id, { name: "Sara" });
  const tutor = await createTutorProfile(tutorAccount.id, { name: "Tariq" });
  const requirement = await createRequirement({ studentId: student.id, areaId: area.id });
  const application = await createApplication({
    requirementId: requirement.id,
    tutorId: tutor.id,
    studentId: student.id,
    initiatedBy: "TUTOR",
    status,
  });
  return {
    student,
    tutor,
    application,
    studentHeaders: await getAuthHeaders(studentAccount),
    tutorHeaders: await getAuthHeaders(tutorAccount),
    studentAccount,
    tutorAccount,
  };
}

async function post(headers: Record<string, string>, payload: object) {
  const app = await createTestApp();
  return app.inject({ method: "POST", url: BASE, headers, payload });
}

describe("POST /reviews", () => {
  it("lets a student review the tutor and updates the tutor rating", async () => {
    const s = await setup();
    const res = await post(s.studentHeaders, {
      applicationId: s.application.id,
      rating: 4,
      comment: "  Patient and clear.  ",
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({
      direction: "STUDENT_TO_TUTOR",
      rating: 4,
      comment: "Patient and clear.",
      status: "VISIBLE",
      canEdit: true,
      subject: { kind: "TUTOR", id: s.tutor.id, name: "Tariq" },
    });
    const tutor = await prisma.tutor.findUniqueOrThrow({ where: { id: s.tutor.id } });
    expect(Number(tutor.ratingAvg)).toBe(4);
    expect(tutor.ratingCount).toBe(1);
  });

  it("lets a tutor review the student on a completed tuition", async () => {
    const s = await setup("COMPLETED");
    const res = await post(s.tutorHeaders, { applicationId: s.application.id, rating: 5 });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      direction: "TUTOR_TO_STUDENT",
      comment: null,
      subject: { kind: "STUDENT", id: s.student.id, name: "Sara" },
    });
    const student = await prisma.student.findUniqueOrThrow({ where: { id: s.student.id } });
    expect(Number(student.ratingAvg)).toBe(5);
    expect(student.ratingCount).toBe(1);
  });

  it("answers 404 to someone who is not a party", async () => {
    const s = await setup();
    const other = await createAccount({ role: "STUDENT" });
    const res = await post(await getAuthHeaders(other), {
      applicationId: s.application.id,
      rating: 5,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toBe("Application not found");
  });

  it("answers 404 when the caller's role is the wrong side of the application", async () => {
    const s = await setup();
    const otherTutor = await createAccount({ role: "TUTOR" });
    await createTutorProfile(otherTutor.id);
    const res = await post(await getAuthHeaders(otherTutor), {
      applicationId: s.application.id,
      rating: 5,
    });
    expect(res.statusCode).toBe(404);
  });

  it("refuses while the application is pending", async () => {
    const s = await setup("PENDING");
    const res = await post(s.studentHeaders, { applicationId: s.application.id, rating: 5 });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("REVIEW_NOT_ALLOWED");
    expect(res.json().message).toBe("You can review once the tuition is confirmed.");
  });

  it("refuses a second review in the same direction", async () => {
    const s = await setup();
    expect(
      (await post(s.studentHeaders, { applicationId: s.application.id, rating: 5 })).statusCode,
    ).toBe(201);
    const res = await post(s.studentHeaders, { applicationId: s.application.id, rating: 3 });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("REVIEW_EXISTS");
    // The other direction is still open.
    const back = await post(s.tutorHeaders, { applicationId: s.application.id, rating: 3 });
    expect(back.statusCode).toBe(201);
  });

  it("gives one 201 and one 409 when two requests race", async () => {
    const s = await setup();
    const results = await Promise.all([
      post(s.studentHeaders, { applicationId: s.application.id, rating: 5 }),
      post(s.studentHeaders, { applicationId: s.application.id, rating: 5 }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(await prisma.review.count()).toBe(1);
  });

  it.each([0, 6, 2.5])("rejects rating %s", async (rating) => {
    const s = await setup();
    const res = await post(s.studentHeaders, { applicationId: s.application.id, rating });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a comment that is blank or too long", async () => {
    const s = await setup();
    for (const comment of ["   ", "x".repeat(1001)]) {
      const res = await post(s.studentHeaders, {
        applicationId: s.application.id,
        rating: 4,
        comment,
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it("needs a signed-in student or tutor", async () => {
    const s = await setup();
    const app = await createTestApp();
    const anon = await app.inject({
      method: "POST",
      url: BASE,
      payload: { applicationId: s.application.id, rating: 5 },
    });
    expect(anon.statusCode).toBe(401);
    const admin = await createAccount({ role: "ADMIN" });
    const res = await post(await getAuthHeaders(admin), {
      applicationId: s.application.id,
      rating: 5,
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects the token of a blocked account with 401", async () => {
    const s = await setup();
    const blocked = await createAccount({ role: "STUDENT", status: "BLOCKED" });
    const res = await post(await getAuthHeaders(blocked), {
      applicationId: s.application.id,
      rating: 5,
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("PATCH /reviews/:id", () => {
  async function reviewed() {
    const s = await setup();
    const created = await post(s.studentHeaders, {
      applicationId: s.application.id,
      rating: 5,
      comment: "Great",
    });
    return { ...s, reviewId: created.json().id as string };
  }

  async function patch(headers: Record<string, string>, id: string, payload: object) {
    const app = await createTestApp();
    return app.inject({ method: "PATCH", url: `${BASE}/${id}`, headers, payload });
  }

  it("lets the author change rating and comment, and the tutor average follows", async () => {
    const s = await reviewed();
    const res = await patch(s.studentHeaders, s.reviewId, { rating: 2, comment: "Slow replies" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ rating: 2, comment: "Slow replies" });
    const tutor = await prisma.tutor.findUniqueOrThrow({ where: { id: s.tutor.id } });
    expect(Number(tutor.ratingAvg)).toBe(2);
    expect(tutor.ratingCount).toBe(1);
  });

  it("clears the comment with null and keeps the rating", async () => {
    const s = await reviewed();
    const res = await patch(s.studentHeaders, s.reviewId, { comment: null });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ rating: 5, comment: null });
  });

  it("needs at least one field", async () => {
    const s = await reviewed();
    expect((await patch(s.studentHeaders, s.reviewId, {})).statusCode).toBe(400);
    expect((await patch(s.studentHeaders, s.reviewId, { rating: 9 })).statusCode).toBe(400);
  });

  it("answers 404 to the reviewed person and to strangers", async () => {
    const s = await reviewed();
    expect((await patch(s.tutorHeaders, s.reviewId, { rating: 1 })).statusCode).toBe(404);
    const other = await createAccount({ role: "STUDENT" });
    expect((await patch(await getAuthHeaders(other), s.reviewId, { rating: 1 })).statusCode).toBe(
      404,
    );
    expect(
      (await patch(s.studentHeaders, "0198a1f0-0000-7000-8000-000000000000", { rating: 1 }))
        .statusCode,
    ).toBe(404);
  });

  it("refuses to edit a hidden review", async () => {
    const s = await reviewed();
    await prisma.review.update({ where: { id: s.reviewId }, data: { status: "HIDDEN" } });
    const res = await patch(s.studentHeaders, s.reviewId, { rating: 1 });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("INVALID_REVIEW_STATE");
  });

  it("refuses after the edit window", async () => {
    const s = await reviewed();
    const old = new Date(Date.now() - (REVIEW_EDIT_WINDOW_DAYS + 1) * 24 * 60 * 60 * 1000);
    await prisma.review.update({ where: { id: s.reviewId }, data: { createdAt: old } });
    const res = await patch(s.studentHeaders, s.reviewId, { rating: 1 });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("REVIEW_NOT_ALLOWED");
    expect(res.json().message).toBe("Reviews can be edited for 30 days.");
  });
});

describe("GET /reviews/mine", () => {
  async function get(headers: Record<string, string>, query = "") {
    const app = await createTestApp();
    return app.inject({ method: "GET", url: `${BASE}/mine${query}`, headers });
  }

  it("lists only what the caller wrote, newest first, with edit info", async () => {
    const s = await setup();
    await post(s.studentHeaders, { applicationId: s.application.id, rating: 4 });
    await post(s.tutorHeaders, { applicationId: s.application.id, rating: 3 });

    const res = await get(s.studentHeaders);
    expect(res.statusCode).toBe(200);
    const { reviews, nextCursor } = res.json();
    expect(nextCursor).toBeNull();
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      direction: "STUDENT_TO_TUTOR",
      rating: 4,
      canEdit: true,
      subject: { kind: "TUTOR", name: "Tariq" },
    });
    const days =
      (Date.parse(reviews[0].editableUntil) - Date.parse(reviews[0].createdAt)) / 86_400_000;
    expect(days).toBe(REVIEW_EDIT_WINDOW_DAYS);

    const tutorSide = (await get(s.tutorHeaders)).json();
    expect(tutorSide.reviews).toHaveLength(1);
    expect(tutorSide.reviews[0].subject.kind).toBe("STUDENT");
  });

  it("shows hidden reviews with canEdit false", async () => {
    const s = await setup();
    const created = await post(s.studentHeaders, { applicationId: s.application.id, rating: 4 });
    await prisma.review.update({ where: { id: created.json().id }, data: { status: "HIDDEN" } });
    const { reviews } = (await get(s.studentHeaders)).json();
    expect(reviews[0]).toMatchObject({ status: "HIDDEN", canEdit: false });
  });

  it("paginates with a cursor", async () => {
    const studentAccount = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    const student = await createStudentProfile(studentAccount.id, area.id);
    for (let i = 0; i < 3; i++) {
      const tutorAccount = await createAccount({ role: "TUTOR" });
      const tutor = await createTutorProfile(tutorAccount.id);
      const requirement = await createRequirement({ studentId: student.id, areaId: area.id });
      await createApplication({
        requirementId: requirement.id,
        tutorId: tutor.id,
        studentId: student.id,
        initiatedBy: "TUTOR",
        status: "CONFIRMED",
      });
      await prisma.review.create({
        data: {
          tutorId: tutor.id,
          studentId: student.id,
          direction: "STUDENT_TO_TUTOR",
          rating: i + 1,
        },
      });
    }
    const headers = await getAuthHeaders(studentAccount);
    const first = (await get(headers, "?limit=2")).json();
    expect(first.reviews.map((r: { rating: number }) => r.rating)).toEqual([3, 2]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = (await get(headers, `?limit=2&cursor=${first.nextCursor}`)).json();
    expect(second.reviews.map((r: { rating: number }) => r.rating)).toEqual([1]);
    expect(second.nextCursor).toBeNull();
    expect((await get(headers, "?cursor=junk")).statusCode).toBe(400);
  });

  it("filters by application, and 404s for a non-party", async () => {
    const s = await setup();
    await post(s.studentHeaders, { applicationId: s.application.id, rating: 4 });
    const res = await get(s.studentHeaders, `?applicationId=${s.application.id}`);
    expect(res.json().reviews).toHaveLength(1);

    // A second application between the same pair resolves to the same review.
    const area = await createArea();
    const second = await createRequirement({ studentId: s.student.id, areaId: area.id });
    const app2 = await createApplication({
      requirementId: second.id,
      tutorId: s.tutor.id,
      studentId: s.student.id,
      initiatedBy: "TUTOR",
      status: "CONFIRMED",
    });
    expect((await get(s.studentHeaders, `?applicationId=${app2.id}`)).json().reviews).toHaveLength(
      1,
    );

    // The tutor wrote nothing yet.
    expect(
      (await get(s.tutorHeaders, `?applicationId=${s.application.id}`)).json().reviews,
    ).toEqual([]);

    const other = await createAccount({ role: "STUDENT" });
    const res404 = await get(await getAuthHeaders(other), `?applicationId=${s.application.id}`);
    expect(res404.statusCode).toBe(404);
  });
});
