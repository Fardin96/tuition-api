import type { Prisma } from "../../generated/prisma/client.js";
import { writeAudit } from "../../lib/admin.js";
import { decodeCursor, encodeCursor } from "../../lib/cursor.js";
import { appError, notFound } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { fileUrl, publishFile, toFileAsset, unpublishFile } from "../files/files.service.js";
import {
  notifyUpload,
  recordUploadReview,
  type UploadFlags,
  uploadFlagsFor,
} from "../files/upload-review.service.js";
import type {
  AdminVideoListQuery,
  AdminVideoPageResponse,
  AdminVideoResponse,
  ModerateVideoInput,
  UpdateVideoInput,
} from "./videos.schema.js";

// PENDING is a work queue (oldest first). APPROVED and REJECTED are history (newest first).
// Both use keyset pagination over (created_at, id).

const videoInclude = {
  file: true,
  tutor: { select: { id: true, accountId: true, name: true, verificationStatus: true } },
} as const;

type VideoRow = Prisma.TutorVideoGetPayload<{ include: typeof videoInclude }>;

const NO_FLAGS: UploadFlags = { recentIssues: 0, uploadsBlocked: false };

async function toAdminVideo(row: VideoRow, flags: UploadFlags): Promise<AdminVideoResponse> {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    moderationNote: row.moderationNote,
    noteVisible: row.noteVisible,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    url: await fileUrl(row.file),
    file: toFileAsset(row.file),
    tutor: row.tutor,
    uploadFlags: flags,
  };
}

export async function listAdminVideos(query: AdminVideoListQuery): Promise<AdminVideoPageResponse> {
  const queue = query.status === "PENDING";
  const where: Prisma.TutorVideoWhereInput = { status: query.status };

  if (query.cursor) {
    const cursor = decodeCursor(query.cursor);
    where.OR = queue
      ? [
          { createdAt: { gt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { gt: cursor.id } },
        ]
      : [
          { createdAt: { lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { lt: cursor.id } },
        ];
  }

  const order: Prisma.SortOrder = queue ? "asc" : "desc";
  const rows = await prisma.tutorVideo.findMany({
    where,
    orderBy: [{ createdAt: order }, { id: order }],
    take: query.limit + 1,
    include: videoInclude,
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];
  const flags = await uploadFlagsFor(
    prisma,
    page.map((row) => row.tutor.accountId),
  );

  return {
    videos: await Promise.all(
      page.map((row) => toAdminVideo(row, flags.get(row.tutor.accountId) ?? NO_FLAGS)),
    ),
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
  };
}

async function getAdminVideo(id: string): Promise<AdminVideoResponse> {
  const row = await prisma.tutorVideo.findUnique({ where: { id }, include: videoInclude });
  if (!row) throw notFound("Video not found");
  const flags = await uploadFlagsFor(prisma, [row.tutor.accountId]);
  return toAdminVideo(row, flags.get(row.tutor.accountId) ?? NO_FLAGS);
}

// Approve publishes the file to the public bucket; reject (or any take-down) removes the copy.
// Any other decision is allowed: a rejected video can be approved, an approved one taken down.
// Each decision writes the audit row, one upload history row and one alert to the tutor.
export async function moderateVideo(
  id: string,
  input: ModerateVideoInput,
  admin: { accountId: string },
  ip: string | undefined,
): Promise<AdminVideoResponse> {
  const { fileId, status } = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM tutor_video WHERE id = ${id}::uuid FOR UPDATE`;
    const current = await tx.tutorVideo.findUnique({
      where: { id },
      include: { file: true, tutor: { select: { accountId: true } } },
    });
    if (!current) throw notFound("Video not found");

    const status = input.decision === "APPROVE" ? "APPROVED" : "REJECTED";
    if (current.status === status) {
      throw appError("VideoAlreadyModerated", 409, "This video already has that decision.");
    }

    // An approval has no note. A rejection keeps the admin's note and its visibility.
    const note = input.decision === "APPROVE" ? null : (input.note ?? null);
    const noteVisible = input.decision === "APPROVE" ? true : input.noteVisible;
    await tx.tutorVideo.update({
      where: { id },
      data: { status, moderationNote: note, noteVisible },
    });

    await writeAudit(tx, {
      actorAccountId: admin.accountId,
      action: "video.moderate",
      entityType: "tutor_video",
      entityId: id,
      before: { status: current.status },
      after: { status, note, noteVisible },
      ip,
    });
    await recordUploadReview(tx, {
      accountId: current.tutor.accountId,
      file: current.file,
      action: status,
      note,
      noteVisible,
      actorAccountId: admin.accountId,
    });
    await notifyUpload(tx, {
      recipientId: current.tutor.accountId,
      kind: status === "APPROVED" ? "VIDEO_APPROVED" : "VIDEO_REJECTED",
      note,
      noteVisible,
      filePurpose: "TUTOR_VIDEO",
    });
    return { fileId: current.fileId, status };
  });

  // The file copy changes after the commit. A failed copy is logged and the video stays on signed URLs.
  if (status === "APPROVED") await publishFile(fileId);
  else await unpublishFile(fileId);
  return getAdminVideo(id);
}

// Display order on the public profile. Lower first.
export async function updateVideo(
  id: string,
  input: UpdateVideoInput,
  admin: { accountId: string },
  ip: string | undefined,
): Promise<AdminVideoResponse> {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM tutor_video WHERE id = ${id}::uuid FOR UPDATE`;
    const current = await tx.tutorVideo.findUnique({ where: { id }, select: { sortOrder: true } });
    if (!current) throw notFound("Video not found");

    await tx.tutorVideo.update({ where: { id }, data: { sortOrder: input.sortOrder } });
    await writeAudit(tx, {
      actorAccountId: admin.accountId,
      action: "video.update",
      entityType: "tutor_video",
      entityId: id,
      before: { sortOrder: current.sortOrder },
      after: { sortOrder: input.sortOrder },
      ip,
    });
  });
  return getAdminVideo(id);
}
