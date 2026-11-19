import type { Prisma } from "../../generated/prisma/client.js";
import { writeAudit } from "../../lib/admin.js";
import { decodeCursor, encodeCursor } from "../../lib/cursor.js";
import { appError, notFound } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import type {
  AdminReviewListQuery,
  AdminReviewPageResponse,
  AdminReviewResponse,
  ModerateReviewInput,
} from "./reviews.schema.js";

const reviewInclude = {
  tutor: { select: { id: true, accountId: true, name: true } },
  student: { select: { id: true, accountId: true, name: true } },
} as const;

type ReviewRow = Prisma.ReviewGetPayload<{ include: typeof reviewInclude }>;

function toAdminReview(row: ReviewRow): AdminReviewResponse {
  return {
    id: row.id,
    direction: row.direction,
    rating: row.rating,
    comment: row.comment,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    tutor: row.tutor,
    student: row.student,
  };
}

// Newest first, keyset pagination over (created_at, id).
export async function listAdminReviews(
  query: AdminReviewListQuery,
): Promise<AdminReviewPageResponse> {
  const where: Prisma.ReviewWhereInput = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.direction ? { direction: query.direction } : {}),
    ...(query.tutorId ? { tutorId: query.tutorId } : {}),
    ...(query.studentId ? { studentId: query.studentId } : {}),
    ...(query.rating ? { rating: query.rating } : {}),
  };

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

  return {
    reviews: page.map(toAdminReview),
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
  };
}

// Hide or restore a review. The rating averages follow by trigger, never written here.
export async function moderateReview(
  id: string,
  input: ModerateReviewInput,
  admin: { accountId: string },
  ip: string | undefined,
): Promise<AdminReviewResponse> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM review WHERE id = ${id}::uuid FOR UPDATE`;
    const current = await tx.review.findUnique({ where: { id }, select: { status: true } });
    if (!current) throw notFound("Review not found");
    if (current.status === input.status) {
      throw appError(
        "InvalidReviewState",
        409,
        input.status === "HIDDEN"
          ? "This review is already hidden."
          : "This review is already visible.",
      );
    }

    const row = await tx.review.update({
      where: { id },
      data: { status: input.status },
      include: reviewInclude,
    });
    await writeAudit(tx, {
      actorAccountId: admin.accountId,
      action: "review.moderate",
      entityType: "review",
      entityId: id,
      before: { status: current.status },
      after: { status: input.status, note: input.note },
      ip,
    });
    return toAdminReview(row);
  });
}
