import type { Prisma, UploadReviewAction } from "../../generated/prisma/client.js";
import { writeAudit } from "../../lib/admin.js";
import { decodeCursor, encodeCursor } from "../../lib/cursor.js";
import { appError, notFound } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { toFileAsset } from "../files/files.service.js";
import {
  notifyUpload,
  recordUploadReview,
  type UploadFlags,
  uploadFlagsFor,
} from "../files/upload-review.service.js";
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

const NO_FLAGS: UploadFlags = { recentIssues: 0, uploadsBlocked: false };

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

function toTutorVerification(
  row: TutorRow,
  extras: { isLatest: boolean; flags: UploadFlags },
): AdminTutorVerificationResponse {
  return {
    id: row.id,
    status: row.status,
    submittedAt: row.submittedAt,
    decidedAt: row.decidedAt,
    note: row.note,
    noteVisible: row.noteVisible,
    reviewedById: row.reviewedById,
    isLatest: extras.isLatest,
    uploadFlags: extras.flags,
    file: toFileAsset(row.file),
    tutor: row.tutor,
  };
}

/** The newest submission of each tutor, ordered the way tutor_verification_sync orders them. */
async function latestSubmissionByTutor(tutorIds: string[]): Promise<Map<string, string>> {
  const rows = await prisma.tutorVerification.findMany({
    where: { tutorId: { in: tutorIds } },
    orderBy: [{ tutorId: "asc" }, { submittedAt: "desc" }, { id: "desc" }],
    distinct: ["tutorId"],
    select: { id: true, tutorId: true },
  });
  return new Map(rows.map((row) => [row.tutorId, row.id]));
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

  const latest = await latestSubmissionByTutor(page.map((row) => row.tutorId));
  const flags = await uploadFlagsFor(
    prisma,
    page.map((row) => row.tutor.accountId),
  );

  return {
    verifications: page.map((row) =>
      toTutorVerification(row, {
        isLatest: latest.get(row.tutorId) === row.id,
        flags: flags.get(row.tutor.accountId) ?? NO_FLAGS,
      }),
    ),
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
      include: tutorInclude,
    });
    if (!current) throw notFound("Verification not found");

    // Only the newest submission counts for the tutor (see tutor_verification_sync).
    const latest = await tx.tutorVerification.findFirst({
      where: { tutorId: current.tutorId },
      orderBy: [{ submittedAt: "desc" }, { id: "desc" }],
      select: { id: true },
    });
    if (latest?.id !== id) {
      throw appError("InvalidVerificationState", 409, "Only the latest submission can be changed.");
    }

    const status = input.decision === "APPROVE" ? "APPROVED" : "REJECTED";
    if (current.status === status) {
      throw appError("InvalidVerificationState", 409, "This submission already has that decision.");
    }
    if (status === "APPROVED" && current.file.status !== "UPLOADED") {
      throw appError(
        "InvalidVerificationState",
        409,
        "The file was removed. Ask for a new upload.",
      );
    }

    // The trigger tutor_verification_sync copies this status to the tutor.
    const note = input.note ?? null;
    const { noteVisible } = input;
    const action: UploadReviewAction =
      status === "APPROVED" ? "APPROVED" : current.status === "APPROVED" ? "REVOKED" : "REJECTED";
    const updated = await tx.tutorVerification.update({
      where: { id },
      data: { status, reviewedById: admin.accountId, decidedAt: new Date(), note, noteVisible },
      include: tutorInclude,
    });

    await writeAudit(tx, {
      actorAccountId: admin.accountId,
      action: "verification.decide",
      entityType: "tutor_verification",
      entityId: id,
      before: { status: current.status },
      after: { status, note, noteVisible },
      ip,
    });
    await recordUploadReview(tx, {
      accountId: current.tutor.accountId,
      file: current.file,
      action,
      note,
      noteVisible,
      actorAccountId: admin.accountId,
    });
    await notifyUpload(tx, {
      recipientId: current.tutor.accountId,
      kind: status === "APPROVED" ? "ID_APPROVED" : "ID_REJECTED",
      note,
      noteVisible,
    });
    return updated;
  });

  const flags = await uploadFlagsFor(prisma, [row.tutor.accountId]);
  return toTutorVerification(row, {
    isLatest: true,
    flags: flags.get(row.tutor.accountId) ?? NO_FLAGS,
  });
}

const studentInclude = {
  verificationFile: true,
} as const;

type StudentRow = Prisma.StudentGetPayload<{ include: typeof studentInclude }>;

function toStudentVerification(
  row: StudentRow,
  flags: UploadFlags,
): AdminStudentVerificationResponse {
  return {
    studentId: row.id,
    status: row.verificationStatus,
    submittedAt: row.verificationSubmittedAt,
    decidedAt: row.verificationDecidedAt,
    note: row.verificationNote,
    noteVisible: row.verificationNoteVisible,
    reviewedById: row.verificationReviewedById,
    uploadFlags: flags,
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
  const flags = await uploadFlagsFor(
    prisma,
    page.map((row) => row.accountId),
  );

  return {
    verifications: page.map((row) =>
      toStudentVerification(row, flags.get(row.accountId) ?? NO_FLAGS),
    ),
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
      include: studentInclude,
    });
    if (!current) throw notFound("Student not found");
    const file = current.verificationFile;
    if (!current.verificationSubmittedAt || !file) {
      throw appError(
        "InvalidVerificationState",
        409,
        "This student has no ID submission to decide.",
      );
    }

    const status = input.decision === "APPROVE" ? "APPROVED" : "REJECTED";
    if (current.verificationStatus === status) {
      throw appError("InvalidVerificationState", 409, "This submission already has that decision.");
    }
    if (status === "APPROVED" && file.status !== "UPLOADED") {
      throw appError(
        "InvalidVerificationState",
        409,
        "The file was removed. Ask for a new upload.",
      );
    }

    const note = input.note ?? null;
    const { noteVisible } = input;
    const action: UploadReviewAction =
      status === "APPROVED"
        ? "APPROVED"
        : current.verificationStatus === "APPROVED"
          ? "REVOKED"
          : "REJECTED";
    const updated = await tx.student.update({
      where: { id },
      data: {
        verificationStatus: status,
        verificationDecidedAt: new Date(),
        verificationReviewedById: admin.accountId,
        verificationNote: note,
        verificationNoteVisible: noteVisible,
      },
      include: studentInclude,
    });

    await writeAudit(tx, {
      actorAccountId: admin.accountId,
      action: "verification.decide",
      entityType: "student",
      entityId: id,
      before: { status: current.verificationStatus },
      after: { status, note, noteVisible },
      ip,
    });
    await recordUploadReview(tx, {
      accountId: current.accountId,
      file,
      action,
      note,
      noteVisible,
      actorAccountId: admin.accountId,
    });
    await notifyUpload(tx, {
      recipientId: current.accountId,
      kind: status === "APPROVED" ? "ID_APPROVED" : "ID_REJECTED",
      note,
      noteVisible,
    });
    return updated;
  });

  const flags = await uploadFlagsFor(prisma, [row.accountId]);
  return toStudentVerification(row, flags.get(row.accountId) ?? NO_FLAGS);
}
