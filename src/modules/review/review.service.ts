import { Prisma } from "../../generated/prisma/client.js";
import type { ReviewDirection } from "../../generated/prisma/enums.js";
import { decodeCursor, encodeCursor } from "../../lib/cursor.js";
import { appError, notFound } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import type { AuthContext } from "../auth/auth.schema.js";
import type {
  CreateReviewInput,
  MyReviewListQuery,
  MyReviewPageResponse,
  MyReviewResponse,
  ReviewSummaryResponse,
  UpdateReviewInput,
} from "./review.schema.js";

// A review can be edited for this long after it was written.
export const REVIEW_EDIT_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const reviewInclude = {
  tutor: { select: { id: true, accountId: true, name: true } },
  student: { select: { id: true, accountId: true, name: true } },
} as const;

type ReviewRow = Prisma.ReviewGetPayload<{ include: typeof reviewInclude }>;

// A student reviews the tutor; a tutor reviews the student.
function directionOf(role: AuthContext["role"]): ReviewDirection {
  return role === "STUDENT" ? "STUDENT_TO_TUTOR" : "TUTOR_TO_STUDENT";
}

function isAuthor(row: ReviewRow, account: AuthContext) {
  return row.direction === "STUDENT_TO_TUTOR"
    ? row.student.accountId === account.accountId
    : row.tutor.accountId === account.accountId;
}

function toMyReview(row: ReviewRow, now = new Date()): MyReviewResponse {
  const editableUntil = new Date(row.createdAt.getTime() + REVIEW_EDIT_WINDOW_DAYS * DAY_MS);
  const subject =
    row.direction === "STUDENT_TO_TUTOR"
      ? { kind: "TUTOR" as const, id: row.tutor.id, name: row.tutor.name }
      : { kind: "STUDENT" as const, id: row.student.id, name: row.student.name };
  return {
    id: row.id,
    direction: row.direction,
    rating: row.rating,
    comment: row.comment,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    editableUntil,
    canEdit: row.status === "VISIBLE" && now < editableUntil,
    subject,
  };
}

// The application when the caller is one of its two parties, else a 404 that does not leak it.
async function findPartyApplication(account: AuthContext, applicationId: string) {
  const application = await prisma.application.findUnique({
    where: { id: applicationId },
    select: {
      id: true,
      status: true,
      tutor: { select: { id: true, accountId: true } },
      student: { select: { id: true, accountId: true } },
    },
  });
  const party = account.role === "STUDENT" ? application?.student : application?.tutor;
  if (!application || party?.accountId !== account.accountId) {
    throw notFound("Application not found");
  }
  return application;
}

function isReviewConflict(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export async function createReview(
  account: AuthContext,
  input: CreateReviewInput,
): Promise<MyReviewResponse> {
  const application = await findPartyApplication(account, input.applicationId);
  if (application.status !== "CONFIRMED" && application.status !== "COMPLETED") {
    throw appError("ReviewNotAllowed", 409, "You can review once the tuition is confirmed.");
  }

  const direction = directionOf(account.role);
  const tutorId = application.tutor.id;
  const studentId = application.student.id;
  const existing = await prisma.review.findUnique({
    where: { tutorId_studentId_direction: { tutorId, studentId, direction } },
    select: { id: true },
  });
  if (existing) throw appError("ReviewExists", 409, "You already reviewed this person.");

  try {
    const row = await prisma.review.create({
      data: { tutorId, studentId, direction, rating: input.rating, comment: input.comment ?? null },
      include: reviewInclude,
    });
    return toMyReview(row);
  } catch (error) {
    // Two requests raced past the check above.
    if (isReviewConflict(error)) {
      throw appError("ReviewExists", 409, "You already reviewed this person.");
    }
    throw error;
  }
}

export async function updateReview(
  account: AuthContext,
  id: string,
  input: UpdateReviewInput,
): Promise<MyReviewResponse> {
  return prisma.$transaction(async (tx) => {
    // Lock first so an admin hiding the review at the same moment cannot be overwritten.
    await tx.$queryRaw`SELECT id FROM review WHERE id = ${id}::uuid FOR UPDATE`;
    const row = await tx.review.findUnique({ where: { id }, include: reviewInclude });
    if (!row || !isAuthor(row, account)) throw notFound("Review not found");

    if (row.status === "HIDDEN") {
      throw appError(
        "InvalidReviewState",
        409,
        "This review was hidden by an admin and can't be edited.",
      );
    }
    const now = new Date();
    if (now.getTime() - row.createdAt.getTime() > REVIEW_EDIT_WINDOW_DAYS * DAY_MS) {
      throw appError("ReviewNotAllowed", 409, "Reviews can be edited for 30 days.");
    }

    const updated = await tx.review.update({
      where: { id },
      data: {
        ...(input.rating !== undefined ? { rating: input.rating } : {}),
        ...(input.comment !== undefined ? { comment: input.comment } : {}),
      },
      include: reviewInclude,
    });
    return toMyReview(updated, now);
  });
}

export async function listMyReviews(
  account: AuthContext,
  query: MyReviewListQuery,
): Promise<MyReviewPageResponse> {
  const direction = directionOf(account.role);
  const where: Prisma.ReviewWhereInput = {
    direction,
    ...(direction === "STUDENT_TO_TUTOR"
      ? { student: { accountId: account.accountId } }
      : { tutor: { accountId: account.accountId } }),
  };

  // A review belongs to a tutor and student pair, so an application resolves to its pair.
  if (query.applicationId) {
    const application = await findPartyApplication(account, query.applicationId);
    where.tutorId = application.tutor.id;
    where.studentId = application.student.id;
  }

  if (query.cursor) {
    const cursor = decodeCursor(query.cursor);
    where.OR = [
      { createdAt: { lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { lt: cursor.id } },
    ];
  }

  const rows = await prisma.review.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: query.limit + 1,
    include: reviewInclude,
  });
  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];
  const now = new Date();

  return {
    reviews: page.map((row) => toMyReview(row, now)),
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
  };
}

// Shared by the public lists on tutors and students: a keyset page of VISIBLE reviews plus the
// rating figures. Average and count come from the profile row (kept by the review trigger).
export async function pageVisibleReviews<T extends { id: string; createdAt: Date }>(
  where: Prisma.ReviewWhereInput,
  query: { cursor?: string; limit: number },
  load: (where: Prisma.ReviewWhereInput, take: number) => Promise<T[]>,
): Promise<{ rows: T[]; nextCursor: string | null }> {
  const filter: Prisma.ReviewWhereInput = { ...where, status: "VISIBLE" };
  if (query.cursor) {
    const cursor = decodeCursor(query.cursor);
    filter.OR = [
      { createdAt: { lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { lt: cursor.id } },
    ];
  }
  const rows = await load(filter, query.limit + 1);
  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];
  return {
    rows: page,
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
  };
}

export async function reviewSummary(
  where: Prisma.ReviewWhereInput,
  ratingAvg: unknown,
  ratingCount: number,
): Promise<ReviewSummaryResponse> {
  const groups = await prisma.review.groupBy({
    by: ["rating"],
    where: { ...where, status: "VISIBLE" },
    _count: { _all: true },
  });
  const breakdown = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 };
  for (const group of groups) {
    if (group.rating >= 1 && group.rating <= 5) {
      breakdown[String(group.rating) as keyof typeof breakdown] = group._count._all;
    }
  }
  return { ratingAvg: Number(ratingAvg), ratingCount, breakdown };
}
