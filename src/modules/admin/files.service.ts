import type { FileAsset, Prisma, VerificationStatus } from "../../generated/prisma/client.js";
import { writeAudit } from "../../lib/admin.js";
import { decodeCursor, encodeCursor } from "../../lib/cursor.js";
import { appError, notFound } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { discardFile, removeObjects, unattachedFileWhere } from "../files/files.service.js";
import { notifyUpload, recordUploadReview } from "../files/upload-review.service.js";
import type { CardSource } from "../site-content/site-content.schema.js";
import { removeSourceFromLanding } from "../site-content/site-content.service.js";
import type {
  AdminFileListQuery,
  AdminFileResponse,
  AdminFileStatsResponse,
  RemoveFileInput,
} from "./files.schema.js";

// Relation counts mirror fileInUse in files/files.service.ts. Keep the two in step.
const adminFileInclude = {
  owner: { select: { email: true } },
  avatarOf: { select: { id: true } },
  _count: {
    select: {
      studentVerifications: true,
      tutorVerifications: true,
      credentials: true,
      videos: true,
      blogCovers: true,
      siteContentUses: true,
      storyImages: true,
      storyVideos: true,
    },
  },
} as const;

type AdminFileRow = Prisma.FileAssetGetPayload<{ include: typeof adminFileInclude }>;

function toAdminFile(row: AdminFileRow): AdminFileResponse {
  const c = row._count;
  return {
    id: row.id,
    purpose: row.purpose,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    status: row.status,
    fileName: row.originalName,
    createdAt: row.createdAt,
    uploadedAt: row.uploadedAt,
    ownerAccountId: row.ownerAccountId,
    ownerEmail: row.owner.email,
    published: row.publishedAt !== null,
    inUse:
      row.avatarOf !== null ||
      c.studentVerifications +
        c.tutorVerifications +
        c.credentials +
        c.videos +
        c.blogCovers +
        c.siteContentUses +
        c.storyImages +
        c.storyVideos >
        0,
  };
}

// Newest first, keyset over (created_at, id).
export async function listAdminFiles(query: AdminFileListQuery): Promise<{
  files: AdminFileResponse[];
  nextCursor: string | null;
}> {
  const clauses: Prisma.FileAssetWhereInput[] = [];
  if (query.purpose) clauses.push({ purpose: query.purpose });
  if (query.status) clauses.push({ status: query.status });
  if (query.ownerAccountId) clauses.push({ ownerAccountId: query.ownerAccountId });
  if (query.unattached === "true") clauses.push({ ...unattachedFileWhere });
  if (query.unattached === "false") clauses.push({ NOT: { ...unattachedFileWhere } });
  if (query.cursor) {
    const cursor = decodeCursor(query.cursor);
    clauses.push({
      OR: [
        { createdAt: { lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, id: { lt: cursor.id } },
      ],
    });
  }

  const rows = await prisma.fileAsset.findMany({
    where: { AND: clauses },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: query.limit + 1,
    include: adminFileInclude,
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];

  return {
    files: page.map(toAdminFile),
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
  };
}

export async function getAdminFile(id: string): Promise<AdminFileResponse> {
  const row = await prisma.fileAsset.findUniqueOrThrow({
    where: { id },
    include: adminFileInclude,
  });
  return toAdminFile(row);
}

// Counts and bytes per purpose and status, over every file row.
export async function getAdminFileStats(): Promise<AdminFileStatsResponse> {
  const groups = await prisma.fileAsset.groupBy({
    by: ["purpose", "status"],
    _count: { _all: true },
    _sum: { sizeBytes: true },
    orderBy: [{ purpose: "asc" }, { status: "asc" }],
  });
  return {
    groups: groups.map((g) => ({
      purpose: g.purpose,
      status: g.status,
      count: g._count._all,
      totalBytes: g._sum.sizeBytes ?? 0,
    })),
  };
}

// A pending ID is always rejected when its file is removed. An approved one only with unverify.
function rejectsOnRemoval(status: VerificationStatus, unverify: boolean): boolean {
  return status === "PENDING" || (status === "APPROVED" && unverify);
}

type Tx = Prisma.TransactionClient;
type RemoveDecision = { note: string; noteVisible: boolean; unverify: boolean };

// Tutor ID: only the tutor's latest submission can change. Returns its status after the removal.
async function removeTutorIdFile(
  tx: Tx,
  fileId: string,
  admin: { accountId: string },
  decision: RemoveDecision,
): Promise<VerificationStatus | null> {
  const using = await tx.tutorVerification.findMany({
    where: { fileId },
    select: { id: true, tutorId: true, status: true },
  });
  // The submission that uses the file is the answer, even when it is not the latest one.
  let after: VerificationStatus | null = null;
  for (const row of using) {
    const latest = await tx.tutorVerification.findFirst({
      where: { tutorId: row.tutorId },
      orderBy: [{ submittedAt: "desc" }, { id: "desc" }],
    });
    after = row.status;
    // An older submission never changes; only the latest one can be decided.
    if (latest?.id !== row.id || !rejectsOnRemoval(row.status, decision.unverify)) continue;
    // tutor.verification_status follows through the tutor_verification_sync trigger.
    await tx.tutorVerification.update({
      where: { id: row.id },
      data: {
        status: "REJECTED",
        reviewedById: admin.accountId,
        decidedAt: new Date(),
        note: decision.note,
        noteVisible: decision.noteVisible,
      },
    });
    after = "REJECTED";
  }
  return after;
}

// Student ID: the student's verification file pointer stays (a CHECK needs it), only the status moves.
async function removeStudentIdFile(
  tx: Tx,
  fileId: string,
  admin: { accountId: string },
  decision: RemoveDecision,
): Promise<VerificationStatus | null> {
  const students = await tx.student.findMany({
    where: { verificationFileId: fileId },
    select: { id: true, verificationStatus: true },
  });
  let after: VerificationStatus | null = null;
  for (const student of students) {
    after = student.verificationStatus;
    if (rejectsOnRemoval(student.verificationStatus, decision.unverify)) {
      await tx.student.update({
        where: { id: student.id },
        data: {
          verificationStatus: "REJECTED",
          verificationReviewedById: admin.accountId,
          verificationDecidedAt: new Date(),
          verificationNote: decision.note,
          verificationNoteVisible: decision.noteVisible,
        },
      });
      after = "REJECTED";
    }
  }
  return after;
}

/**
 * The story or tutor video a file belongs to, if any. A plain read: the caller locks the source row
 * next and checks again through removeSourceFromLanding.
 */
async function sourceOfFile(tx: Tx, fileId: string): Promise<CardSource | null> {
  const story = await tx.story.findFirst({
    where: { OR: [{ imageFileId: fileId }, { videoFileId: fileId }] },
    select: { id: true },
  });
  if (story) return { kind: "story", id: story.id };
  const video = await tx.tutorVideo.findUnique({ where: { fileId }, select: { id: true } });
  return video ? { kind: "tutor_video", id: video.id } : null;
}

/**
 * Takes an uploaded file down for its owner, in one transaction: the record that uses it is
 * changed or removed, the file is marked DELETED, and the change is audited, kept in the upload
 * history and sent to the owner as an alert. The stored copies are removed after the commit.
 * 404 when the file is missing or already removed; 400 for a blog cover (remove it from its post)
 * or site media (replace it in Site content).
 *
 * A story or tutor video file takes its card off the landing page first. A story goes with all its
 * files. Lock order: the source row, the landing lists, then the file row.
 */
export async function removeFile(
  fileId: string,
  input: RemoveFileInput,
  admin: { accountId: string },
  ip: string | undefined,
): Promise<AdminFileResponse> {
  const decision: RemoveDecision = {
    note: input.note,
    noteVisible: input.noteVisible,
    unverify: input.unverify,
  };
  const removed = await prisma.$transaction(async (tx) => {
    const source = await sourceOfFile(tx, fileId);
    if (source?.kind === "story") {
      await tx.$queryRaw`SELECT id FROM story WHERE id = ${source.id}::uuid FOR UPDATE`;
    } else if (source) {
      await tx.$queryRaw`SELECT id FROM tutor_video WHERE id = ${source.id}::uuid FOR UPDATE`;
    }
    if (source) await removeSourceFromLanding(tx, source, admin.accountId);

    await tx.$queryRaw`SELECT id FROM file_asset WHERE id = ${fileId}::uuid FOR UPDATE`;
    const row: FileAsset | null = await tx.fileAsset.findUnique({ where: { id: fileId } });
    if (!row || row.status === "DELETED") throw notFound("File not found");
    if (row.purpose === "BLOG_COVER") {
      throw appError("InvalidFile", 400, "Remove a blog cover from its post.");
    }
    if (row.purpose === "SITE_IMAGE" || row.purpose === "SITE_VIDEO") {
      throw appError("InvalidFile", 400, "Replace this file in Site content first.");
    }

    let verificationStatus: VerificationStatus | null = null;
    // Files that go with the removed record, besides this one.
    const alsoRemoved: FileAsset[] = [];
    if (row.purpose === "TUTOR_ID") {
      verificationStatus = await removeTutorIdFile(tx, row.id, admin, decision);
    } else if (row.purpose === "STUDENT_ID") {
      verificationStatus = await removeStudentIdFile(tx, row.id, admin, decision);
    } else if (row.purpose === "CREDENTIAL") {
      await tx.tutorCredential.deleteMany({ where: { fileId: row.id } });
    } else if (row.purpose === "TUTOR_VIDEO") {
      await tx.tutorVideo.deleteMany({ where: { fileId: row.id } });
    } else if (row.purpose === "AVATAR") {
      // The owner shows the Google picture again, or no picture.
      await tx.account.updateMany({
        where: { avatarFileId: row.id },
        data: { avatarFileId: null },
      });
    } else if (row.purpose === "STORY_IMAGE" || row.purpose === "STORY_VIDEO") {
      const story = await tx.story.findFirst({
        where: { OR: [{ imageFileId: row.id }, { videoFileId: row.id }] },
      });
      if (story) {
        await tx.story.delete({ where: { id: story.id } });
        for (const other of [story.imageFileId, story.videoFileId]) {
          if (!other || other === row.id) continue;
          const file = await discardFile(tx, other);
          if (file) alsoRemoved.push(file);
        }
      }
    }

    const file = await discardFile(tx, row.id);
    if (!file) throw notFound("File not found");
    await writeAudit(tx, {
      actorAccountId: admin.accountId,
      action: "file.remove",
      entityType: "file_asset",
      entityId: row.id,
      before: { status: row.status, purpose: row.purpose, ownerAccountId: row.ownerAccountId },
      after: {
        note: input.note,
        noteVisible: input.noteVisible,
        unverify: input.unverify,
        verificationStatus,
      },
      ip,
    });
    await recordUploadReview(tx, {
      accountId: row.ownerAccountId,
      file: row,
      action: "REMOVED",
      note: input.note,
      noteVisible: input.noteVisible,
      actorAccountId: admin.accountId,
    });
    await notifyUpload(tx, {
      recipientId: row.ownerAccountId,
      kind: "FILE_REMOVED",
      note: input.note,
      noteVisible: input.noteVisible,
      filePurpose: row.purpose,
    });
    return [file, ...alsoRemoved];
  });

  // Best-effort: a failed delete is logged and the file-cleanup cron retries it.
  await removeObjects(removed);
  return getAdminFile(fileId);
}
