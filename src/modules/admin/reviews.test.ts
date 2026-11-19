import { describe, expect, it } from "vitest";
import { prisma } from "../../lib/prisma.js";
import {
  createAccount,
  createAdmin,
  createApplication,
  createArea,
  createRequirement,
  createStudentProfile,
  createTestApp,
  createTutorProfile,
  getAuthHeaders,
} from "../../tests/helpers.js";

const BASE = "/api/v1/admin/reviews";

// A tutor and a student with a CONFIRMED application, so a review between them is allowed.
async function match(
  names: { tutor?: string; student?: string; sameTutor?: { id: string; accountId: string } } = {},
) {
  const tutorAccount = names.sameTutor
    ? { id: names.sameTutor.accountId }
    : await createAccount({ role: "TUTOR" });
  const tutor = names.sameTutor
    ? await prisma.tutor.findUniqueOrThrow({ where: { id: names.sameTutor.id } })
    : await createTutorProfile(tutorAccount.id, { name: names.tutor });
  const studentAccount = await createAccount({ role: "STUDENT" });
  const area = await createArea();
  const student = await createStudentProfile(studentAccount.id, area.id, {
    name: names.student,
  });
  const requirement = await createRequirement({ studentId: student.id, areaId: area.id });
  await createApplication({
    requirementId: requirement.id,
    tutorId: tutor.id,
    studentId: student.id,
    initiatedBy: "TUTOR",
    status: "CONFIRMED",
  });
  return { tutor, tutorAccount, student, studentAccount };
}

async function review(
  options: {
    rating?: number;
    direction?: "STUDENT_TO_TUTOR" | "TUTOR_TO_STUDENT";
    status?: "VISIBLE" | "HIDDEN";
    comment?: string | null;
    createdAt?: Date;
    pair?: Awaited<ReturnType<typeof match>>;
  } = {},
) {
  const pair = options.pair ?? (await match());
  const row = await prisma.review.create({
    data: {
      tutorId: pair.tutor.id,
      studentId: pair.student.id,
      direction: options.direction ?? "STUDENT_TO_TUTOR",
      rating: options.rating ?? 5,
      comment: options.comment === undefined ? "Great lessons" : options.comment,
      status: options.status ?? "VISIBLE",
      createdAt: options.createdAt,
    },
  });
  return { row, ...pair };
}

describe("admin reviews", () => {
  describe("access", () => {
    it("rejects non-admins and pending admins with 403, and no token with 401", async () => {
      const app = await createTestApp();
      const student = await createAccount({ role: "STUDENT" });
      const pending = await createAdmin({ status: "PENDING" });

      const asStudent = await app.inject({
        method: "GET",
        url: BASE,
        headers: await getAuthHeaders(student),
      });
      const asPending = await app.inject({
        method: "GET",
        url: BASE,
        headers: await getAuthHeaders(pending),
      });
      const anonymous = await app.inject({ method: "GET", url: BASE });

      expect(asStudent.statusCode).toBe(403);
      expect(asPending.statusCode).toBe(403);
      expect(anonymous.statusCode).toBe(401);
    });

    it("sends private, no-store", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });

      const res = await app.inject({
        method: "GET",
        url: BASE,
        headers: await getAuthHeaders(admin),
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe("private, no-store");
    });
  });

  describe("GET /", () => {
    it("lists newest first with parties, hidden reviews included, and pages with nextCursor", async () => {
      const app = await createTestApp();
      const headers = await getAuthHeaders(await createAdmin({ status: "ACTIVE" }));
      const old = await review({
        createdAt: new Date("2026-06-01T00:00:00Z"),
        pair: await match({ tutor: "Tara Tutor", student: "Sam Student" }),
      });
      const mid = await review({ createdAt: new Date("2026-06-02T00:00:00Z"), status: "HIDDEN" });
      const recent = await review({ createdAt: new Date("2026-06-03T00:00:00Z") });

      const first = await app.inject({ method: "GET", url: `${BASE}?limit=2`, headers });
      expect(first.statusCode).toBe(200);
      const firstBody = JSON.parse(first.body);
      expect(firstBody.reviews.map((r: { id: string }) => r.id)).toEqual([
        recent.row.id,
        mid.row.id,
      ]);
      expect(firstBody.reviews[1].status).toBe("HIDDEN");
      expect(firstBody.nextCursor).toEqual(expect.any(String));

      const second = await app.inject({
        method: "GET",
        url: `${BASE}?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
        headers,
      });
      const secondBody = JSON.parse(second.body);
      expect(secondBody.nextCursor).toBeNull();
      expect(secondBody.reviews).toHaveLength(1);
      expect(secondBody.reviews[0]).toMatchObject({
        id: old.row.id,
        direction: "STUDENT_TO_TUTOR",
        rating: 5,
        comment: "Great lessons",
        status: "VISIBLE",
        tutor: { id: old.tutor.id, accountId: old.tutorAccount.id, name: "Tara Tutor" },
        student: { id: old.student.id, accountId: old.studentAccount.id, name: "Sam Student" },
      });
    });

    it("filters by status, direction, tutorId, studentId and rating", async () => {
      const app = await createTestApp();
      const headers = await getAuthHeaders(await createAdmin({ status: "ACTIVE" }));
      const a = await review({ rating: 2, status: "HIDDEN" });
      const b = await review({ rating: 4, direction: "TUTOR_TO_STUDENT" });
      const c = await review({ rating: 4 });
      const ids = async (query: string) =>
        (
          JSON.parse((await app.inject({ method: "GET", url: `${BASE}?${query}`, headers })).body)
            .reviews as { id: string }[]
        )
          .map((r) => r.id)
          .sort();

      expect(await ids("status=HIDDEN")).toEqual([a.row.id]);
      expect(await ids("direction=TUTOR_TO_STUDENT")).toEqual([b.row.id]);
      expect(await ids(`tutorId=${c.tutor.id}`)).toEqual([c.row.id]);
      expect(await ids(`studentId=${a.student.id}`)).toEqual([a.row.id]);
      expect(await ids("rating=4")).toEqual([b.row.id, c.row.id].sort());
      expect(await ids("rating=4&status=VISIBLE&direction=STUDENT_TO_TUTOR")).toEqual([c.row.id]);
    });

    it("rejects a rating outside 1 to 5 and a bad cursor with 400", async () => {
      const app = await createTestApp();
      const headers = await getAuthHeaders(await createAdmin({ status: "ACTIVE" }));

      const rating = await app.inject({ method: "GET", url: `${BASE}?rating=6`, headers });
      const cursor = await app.inject({ method: "GET", url: `${BASE}?cursor=nope`, headers });

      expect(rating.statusCode).toBe(400);
      expect(cursor.statusCode).toBe(400);
    });
  });

  describe("PATCH /:id", () => {
    it("hides a review, updates the tutor rating, audits it, and restores it", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const headers = await getAuthHeaders(admin);
      const first = await review({ rating: 5 });
      await review({ rating: 3, pair: await match({ sameTutor: first.tutor }) });
      const before = await prisma.tutor.findUniqueOrThrow({ where: { id: first.tutor.id } });
      expect(before.ratingCount).toBe(2);
      expect(Number(before.ratingAvg)).toBe(4);

      const hide = await app.inject({
        method: "PATCH",
        url: `${BASE}/${first.row.id}`,
        headers,
        payload: { status: "HIDDEN", note: "  Contains abuse  " },
      });

      expect(hide.statusCode).toBe(200);
      expect(JSON.parse(hide.body)).toMatchObject({
        id: first.row.id,
        status: "HIDDEN",
        tutor: { id: first.tutor.id },
      });
      const hidden = await prisma.tutor.findUniqueOrThrow({ where: { id: first.tutor.id } });
      expect(hidden.ratingCount).toBe(1);
      expect(Number(hidden.ratingAvg)).toBe(3);
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: "review.moderate", entityId: first.row.id },
      });
      expect(audit.actorAccountId).toBe(admin.id);
      expect(audit.entityType).toBe("review");
      expect(audit.before).toEqual({ status: "VISIBLE" });
      expect(audit.after).toEqual({ status: "HIDDEN", note: "Contains abuse" });

      const restore = await app.inject({
        method: "PATCH",
        url: `${BASE}/${first.row.id}`,
        headers,
        payload: { status: "VISIBLE", note: "Reviewed, fine" },
      });

      expect(restore.statusCode).toBe(200);
      const restored = await prisma.tutor.findUniqueOrThrow({ where: { id: first.tutor.id } });
      expect(restored.ratingCount).toBe(2);
      expect(Number(restored.ratingAvg)).toBe(4);
    });

    it("updates the student rating for a TUTOR_TO_STUDENT review", async () => {
      const app = await createTestApp();
      const headers = await getAuthHeaders(await createAdmin({ status: "ACTIVE" }));
      const { row, student } = await review({ rating: 2, direction: "TUTOR_TO_STUDENT" });
      expect(
        (await prisma.student.findUniqueOrThrow({ where: { id: student.id } })).ratingCount,
      ).toBe(1);

      const res = await app.inject({
        method: "PATCH",
        url: `${BASE}/${row.id}`,
        headers,
        payload: { status: "HIDDEN", note: "Not a fair review" },
      });

      expect(res.statusCode).toBe(200);
      const after = await prisma.student.findUniqueOrThrow({ where: { id: student.id } });
      expect(after.ratingCount).toBe(0);
      expect(Number(after.ratingAvg)).toBe(0);
    });

    it("answers 409 INVALID_REVIEW_STATE when the status does not change, and writes no audit row", async () => {
      const app = await createTestApp();
      const headers = await getAuthHeaders(await createAdmin({ status: "ACTIVE" }));
      const { row } = await review({ status: "HIDDEN" });

      const res = await app.inject({
        method: "PATCH",
        url: `${BASE}/${row.id}`,
        headers,
        payload: { status: "HIDDEN", note: "Again" },
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).code).toBe("INVALID_REVIEW_STATE");
      expect(await prisma.auditLog.count({ where: { action: "review.moderate" } })).toBe(0);
    });

    it("validates the body", async () => {
      const app = await createTestApp();
      const headers = await getAuthHeaders(await createAdmin({ status: "ACTIVE" }));
      const { row } = await review();
      const send = async (payload: unknown) =>
        (
          await app.inject({
            method: "PATCH",
            url: `${BASE}/${row.id}`,
            headers,
            payload: payload as object,
          })
        ).statusCode;

      expect(await send({ status: "HIDDEN" })).toBe(400);
      expect(await send({ status: "HIDDEN", note: "  ab  " })).toBe(400);
      expect(await send({ status: "HIDDEN", note: "x".repeat(501) })).toBe(400);
      expect(await send({ status: "DELETED", note: "Not allowed" })).toBe(400);
      expect(await send({ status: "HIDDEN", note: "Fine reason", rating: 1 })).toBe(400);
    });

    it("answers 404 for an unknown review and 403 for a non-admin", async () => {
      const app = await createTestApp();
      const admin = await createAdmin({ status: "ACTIVE" });
      const tutor = await createAccount({ role: "TUTOR" });
      const { row } = await review();

      const missing = await app.inject({
        method: "PATCH",
        url: `${BASE}/0190a000-0000-7000-8000-000000000000`,
        headers: await getAuthHeaders(admin),
        payload: { status: "HIDDEN", note: "Gone" },
      });
      const forbidden = await app.inject({
        method: "PATCH",
        url: `${BASE}/${row.id}`,
        headers: await getAuthHeaders(tutor),
        payload: { status: "HIDDEN", note: "Nope" },
      });

      expect(missing.statusCode).toBe(404);
      expect(forbidden.statusCode).toBe(403);
    });
  });
});
