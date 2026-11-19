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

// A tutor and `ratings.length` students, each with a confirmed application and a review.
async function seedTutorReviews(ratings: number[]) {
  const tutorAccount = await createAccount({ role: "TUTOR" });
  const tutor = await createTutorProfile(tutorAccount.id);
  const area = await createArea();
  const reviews: { id: string; studentId: string }[] = [];
  for (const [i, rating] of ratings.entries()) {
    const account = await createAccount({ role: "STUDENT" });
    const student = await createStudentProfile(account.id, area.id, { name: `Student ${i}` });
    const requirement = await createRequirement({ studentId: student.id, areaId: area.id });
    await createApplication({
      requirementId: requirement.id,
      tutorId: tutor.id,
      studentId: student.id,
      initiatedBy: "TUTOR",
      status: "CONFIRMED",
    });
    const review = await prisma.review.create({
      data: {
        tutorId: tutor.id,
        studentId: student.id,
        direction: "STUDENT_TO_TUTOR",
        rating,
        comment: `c${i}`,
      },
    });
    reviews.push({ id: review.id, studentId: student.id });
  }
  return { tutor, tutorAccount, reviews };
}

describe("GET /tutors/:id/reviews", () => {
  it("paginates, keeps the item shape and adds a summary", async () => {
    const { tutor } = await seedTutorReviews([5, 4, 4, 1]);
    const app = await createTestApp();

    const first = await app.inject({
      method: "GET",
      url: `/api/v1/tutors/${tutor.id}/reviews?limit=3`,
    });
    expect(first.statusCode).toBe(200);
    expect(first.headers["cache-control"]).toBe("public, max-age=300, stale-while-revalidate=600");
    const body = first.json();
    expect(body.reviews).toHaveLength(3);
    expect(body.reviews.map((r: { rating: number }) => r.rating)).toEqual([1, 4, 4]);
    expect(body.reviews[0]).toEqual({
      id: expect.any(String),
      rating: 1,
      comment: "c3",
      createdAt: expect.any(String),
      student: { id: expect.any(String), name: "Student 3" },
    });
    expect(body.summary).toEqual({
      ratingAvg: 3.5,
      ratingCount: 4,
      breakdown: { "1": 1, "2": 0, "3": 0, "4": 2, "5": 1 },
    });

    const second = await app.inject({
      method: "GET",
      url: `/api/v1/tutors/${tutor.id}/reviews?limit=3&cursor=${body.nextCursor}`,
    });
    expect(second.json().reviews.map((r: { rating: number }) => r.rating)).toEqual([5]);
    expect(second.json().nextCursor).toBeNull();
  });

  it("leaves out hidden reviews everywhere, including the summary", async () => {
    const { tutor, reviews } = await seedTutorReviews([5, 1]);
    await prisma.review.update({ where: { id: reviews[1]?.id }, data: { status: "HIDDEN" } });
    const app = await createTestApp();
    const res = await app.inject({ method: "GET", url: `/api/v1/tutors/${tutor.id}/reviews` });
    const body = res.json();
    expect(body.reviews).toHaveLength(1);
    expect(body.summary).toEqual({
      ratingAvg: 5,
      ratingCount: 1,
      breakdown: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 1 },
    });
  });

  it("returns an empty summary when there are no reviews, and 404 for an unknown tutor", async () => {
    const account = await createAccount({ role: "TUTOR" });
    const tutor = await createTutorProfile(account.id);
    const app = await createTestApp();
    const res = await app.inject({ method: "GET", url: `/api/v1/tutors/${tutor.id}/reviews` });
    expect(res.json()).toMatchObject({
      reviews: [],
      nextCursor: null,
      summary: { ratingAvg: 0, ratingCount: 0 },
    });
    const missing = await app.inject({
      method: "GET",
      url: "/api/v1/tutors/0198a1f0-0000-7000-8000-000000000000/reviews",
    });
    expect(missing.statusCode).toBe(404);
  });

  it("rejects a bad limit or cursor", async () => {
    const { tutor } = await seedTutorReviews([5]);
    const app = await createTestApp();
    for (const q of ["limit=0", "limit=101", "cursor=junk"]) {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/tutors/${tutor.id}/reviews?${q}`,
      });
      expect(res.statusCode).toBe(400);
    }
  });
});

describe("GET /students/:id/reviews", () => {
  it("paginates tutor reviews of a student with a summary", async () => {
    const studentAccount = await createAccount({ role: "STUDENT" });
    const area = await createArea();
    const student = await createStudentProfile(studentAccount.id, area.id);
    const ratings = [3, 5, 5];
    for (const [i, rating] of ratings.entries()) {
      const account = await createAccount({ role: "TUTOR" });
      const tutor = await createTutorProfile(account.id, { name: `Tutor ${i}` });
      const requirement = await createRequirement({ studentId: student.id, areaId: area.id });
      await createApplication({
        requirementId: requirement.id,
        tutorId: tutor.id,
        studentId: student.id,
        initiatedBy: "TUTOR",
        status: "COMPLETED",
      });
      await prisma.review.create({
        data: { tutorId: tutor.id, studentId: student.id, direction: "TUTOR_TO_STUDENT", rating },
      });
    }
    const headers = await getAuthHeaders(studentAccount);
    const app = await createTestApp();
    const first = await app.inject({
      method: "GET",
      url: `/api/v1/students/${student.id}/reviews?limit=2`,
      headers,
    });
    expect(first.statusCode).toBe(200);
    const body = first.json();
    expect(body.reviews.map((r: { rating: number }) => r.rating)).toEqual([5, 5]);
    expect(body.reviews[0].tutor.name).toBe("Tutor 2");
    expect(body.summary).toEqual({
      ratingAvg: 4.33,
      ratingCount: 3,
      breakdown: { "1": 0, "2": 0, "3": 1, "4": 0, "5": 2 },
    });
    const second = await app.inject({
      method: "GET",
      url: `/api/v1/students/${student.id}/reviews?limit=2&cursor=${body.nextCursor}`,
      headers,
    });
    expect(second.json().reviews).toHaveLength(1);
    expect(second.json().nextCursor).toBeNull();
  });

  it("404s for an unknown student and 401s anonymous callers", async () => {
    const account = await createAccount({ role: "TUTOR" });
    const app = await createTestApp();
    const missing = await app.inject({
      method: "GET",
      url: "/api/v1/students/0198a1f0-0000-7000-8000-000000000000/reviews",
      headers: await getAuthHeaders(account),
    });
    expect(missing.statusCode).toBe(404);
    const anon = await app.inject({
      method: "GET",
      url: "/api/v1/students/0198a1f0-0000-7000-8000-000000000000/reviews",
    });
    expect(anon.statusCode).toBe(401);
  });
});
