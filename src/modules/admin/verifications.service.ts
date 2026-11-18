import type { Prisma } from "../../generated/prisma/client.js";
import { writeAudit } from "../../lib/admin.js";
import { decodeCursor, encodeCursor } from "../../lib/cursor.js";
import { appError, notFound } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { toFileAsset } from "../files/files.service.js";
import type {
  AdminStudentVerificationPageResponse,
  AdminStudentVerificationResponse,
  AdminTutorVerificationPageResponse,
  AdminTutorVerificationResponse,
  DecideVerificationInput,
  VerificationListQuery,
} from "./verifications.schema.js";

// Same queue rules as packages: PENDING is a work queue (oldest first), the other statuses are
// history (newest first). Both use keyset pagination over (submitted_at, id).

const tutorInclude = {
  file: true,
  tutor: {
    select: {
      id: true,
      accountId: true,
      name: true,
      instituteName: true,
      studentIdNumber: true,
      verificationStatus: true,
    },
  },
} as const;

type TutorRow = Prisma.TutorVerificationGetPayload<{ include: typeof tutorInclude }>;

function toTutorVerification(row: TutorRow): AdminTutorVerificationResponse {
  return {
    id: row.id,
    status: row.status,
    submittedAt: row.submittedAt,
    decidedAt: row.decidedAt,
    note: row.note,
    reviewedById: row.reviewedById,
    file: toFileAsset(row.file),
    tutor: row.tutor,
  };
}

export async function listTutorVerifications(
  query: VerificationListQuery,
): Promise<AdminTutorVerificationPageResponse> {
  const queue = query.status === "PENDING";
  const where: Prisma.TutorVerificationWhereInput = { status: query.status };

  if (query.cursor) {
    const cursor = decodeCursor(query.cursor);
    where.OR = queue
      ? [
          { submittedAt: { gt: cursor.createdAt } },
          { submittedAt: cursor.createdAt, id: { gt: cursor.id } },
        ]
      : [
          { submittedAt: { lt: cursor.createdAt } },
          { submittedAt: cursor.createdAt, id: { lt: cursor.id } },
        ];
  }

  const order: Prisma.SortOrder = queue ? "asc" : "desc";
  const rows = await prisma.tutorVerification.findMany({
    where,
    orderBy: [{ submittedAt: order }, { id: order }],
    take: query.limit + 1,
    include: tutorInclude,
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];

  return {
    verifications: page.map(toTutorVerification),
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.submittedAt, id: last.id }) : null,
  };
}

export async function decideTutorVerification(
  id: string,
  input: DecideVerificationInput,
  admin: { accountId: string },
  ip: string | undefined,
): Promise<AdminTutorVerificationResponse> {
  const row = await prisma.$transaction(async (tx) => {
    // Lock the submission first so two admins cannot decide it at the same time.
    await tx.$queryRaw`SELECT id FROM tutor_verification WHERE id = ${id}::uuid FOR UPDATE`;
    const current = await tx.tutorVerification.findUnique({
      where: { id },
      select: { status: true },
    });
    if (!current) throw notFound("Verification not found");
    if (current.status !== "PENDING") {
      throw appError("InvalidVerificationState", 409, "This submission was already reviewed.");
    }

    // The trigger tutor_verification_sync copies this status to the tutor.
    const status = input.decision === "APPROVE" ? "APPROVED" : "REJECTED";
    const note = input.note ?? null;
    const updated = await tx.tutorVerification.update({
      where: { id },
      data: { status, reviewedById: admin.accountId, decidedAt: new Date(), note },
      include: tutorInclude,
    });

    await writeAudit(tx, {
      actorAccountId: admin.accountId,
      action: "verification.decide",
      entityType: "tutor_verification",
      entityId: id,
      before: { status: "PENDING" },
      after: { status, note },
      ip,
    });
    return updated;
  });
  return toTutorVerification(row);
}

const studentInclude = {
  verificationFile: true,
} as const;

type StudentRow = Prisma.StudentGetPayload<{ include: typeof studentInclude }>;

function toStudentVerification(row: StudentRow): AdminStudentVerificationResponse {
  return {
    studentId: row.id,
    status: row.verificationStatus,
    submittedAt: row.verificationSubmittedAt,
    decidedAt: row.verificationDecidedAt,
    note: row.verificationNote,
    reviewedById: row.verificationReviewedById,
    file: row.verificationFile ? toFileAsset(row.verificationFile) : null,
    student: {
      id: row.id,
      accountId: row.accountId,
      name: row.name,
      studentIdNumber: row.studentIdNumber,
    },
  };
}

// Only submissions with a submission time are listed. Students verified before the upload
// release have none and no file to review.
export async function listStudentVerifications(
  query: VerificationListQuery,
): Promise<AdminStudentVerificationPageResponse> {
  const queue = query.status === "PENDING";
  const where: Prisma.StudentWhereInput = {
    verificationStatus: query.status,
    verificationSubmittedAt: { not: null },
  };

  if (query.cursor) {
    const cursor = decodeCursor(query.cursor);
    where.OR = queue
      ? [
          { verificationSubmittedAt: { gt: cursor.createdAt } },
          { verificationSubmittedAt: cursor.createdAt, id: { gt: cursor.id } },
        ]
      : [
          { verificationSubmittedAt: { lt: cursor.createdAt } },
          { verificationSubmittedAt: cursor.createdAt, id: { lt: cursor.id } },
        ];
  }

  const order: Prisma.SortOrder = queue ? "asc" : "desc";
  const rows = await prisma.student.findMany({
    where,
    orderBy: [{ verificationSubmittedAt: order }, { id: order }],
    take: query.limit + 1,
    include: studentInclude,
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];
  const lastSubmitted = last?.verificationSubmittedAt;

  return {
    verifications: page.map(toStudentVerification),
    nextCursor:
      hasMore && last && lastSubmitted
        ? encodeCursor({ createdAt: lastSubmitted, id: last.id })
        : null,
  };
}

export async function decideStudentVerification(
  id: string,
  input: DecideVerificationInput,
  admin: { accountId: string },
  ip: string | undefined,
): Promise<AdminStudentVerificationResponse> {
  const row = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM student WHERE id = ${id}::uuid FOR UPDATE`;
    const current = await tx.student.findUnique({
      where: { id },
      select: { verificationStatus: true },
    });
    if (!current) throw notFound("Student not found");
    if (current.verificationStatus !== "PENDING") {
      throw appError("InvalidVerificationState", 409, "This submission was already reviewed.");
    }

    const status = input.decision === "APPROVE" ? "APPROVED" : "REJECTED";
    const note = input.note ?? null;
    const updated = await tx.student.update({
      where: { id },
      data: {
        verificationStatus: status,
        verificationDecidedAt: new Date(),
        verificationReviewedById: admin.accountId,
        verificationNote: note,
      },
      include: studentInclude,
    });

    await writeAudit(tx, {
      actorAccountId: admin.accountId,
      action: "verification.decide",
      entityType: "student",
      entityId: id,
      before: { status: "PENDING" },
      after: { status, note },
      ip,
    });
    return updated;
  });
  return toStudentVerification(row);
}
