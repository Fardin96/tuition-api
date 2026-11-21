import type { FileAsset, Prisma } from "../../generated/prisma/client.js";
import { writeAudit } from "../../lib/admin.js";
import { decodeCursor, encodeCursor } from "../../lib/cursor.js";
import { appError, notFound } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { fileUrl, publishFile, unpublishFile } from "../files/files.service.js";
import { visibleNote } from "../files/upload-review.service.js";
import {
  landingSourceKeys,
  removeSourceFromLanding,
} from "../site-content/site-content.service.js";
import type {
  AdminStoryListQuery,
  AdminStoryPageResponse,
  AdminStoryResponse,
  ModerateStoryInput,
} from "./stories.schema.js";

// The review queue. Newest first for every status, keyset over (created_at, id).

const adminStoryInclude = {
  image: true,
  video: true,
  account: {
    select: {
      id: true,
      student: { select: { name: true } },
      tutor: { select: { name: true } },
    },
  },
} as const;

type AdminStoryRow = Prisma.StoryGetPayload<{ include: typeof adminStoryInclude }>;

async function mediaOf(file: FileAsset | null) {
  return file
    ? { url: await fileUrl(file), contentType: file.contentType, originalName: file.originalName }
    : null;
}

async function toAdminStory(
  row: AdminStoryRow,
  onLanding: Set<string>,
): Promise<AdminStoryResponse> {
  return {
    id: row.id,
    author: {
      accountId: row.account.id,
      name: row.account.student?.name ?? row.account.tutor?.name ?? "",
      role: row.role,
    },
    role: row.role,
    headline: row.headline,
    body: row.body,
    status: row.status,
    note: row.moderationNote,
    noteVisible: row.noteVisible,
    image: await mediaOf(row.image),
    video: await mediaOf(row.video),
    consentAt: row.consentAt,
    createdAt: row.createdAt,
    decidedAt: row.decidedAt,
    onLanding: onLanding.has(`story:${row.id}`),
  };
}

export async function listAdminStories(
  query: AdminStoryListQuery,
): Promise<AdminStoryPageResponse> {
  const and: Prisma.StoryWhereInput[] = [{ status: query.status }];
  if (query.role) and.push({ role: query.role });
  if (query.cursor) {
    const cursor = decodeCursor(query.cursor);
    and.push({
      OR: [
        { createdAt: { lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, id: { lt: cursor.id } },
      ],
    });
  }

  const rows = await prisma.story.findMany({
    where: { AND: and },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: query.limit + 1,
    include: adminStoryInclude,
  });
  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];

  const onLanding = await landingSourceKeys();
  return {
    stories: await Promise.all(page.map((row) => toAdminStory(row, onLanding))),
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
  };
}

async function getAdminStory(id: string): Promise<AdminStoryResponse> {
  const row = await prisma.story.findUnique({ where: { id }, include: adminStoryInclude });
  if (!row) throw notFound("Story not found");
  return toAdminStory(row, await landingSourceKeys());
}

// Approve publishes the story's files; reject takes them down and removes the story from the landing page
// in the same transaction. Each decision is audited and sends the author an alert.
export async function moderateStory(
  id: string,
  input: ModerateStoryInput,
  admin: { accountId: string },
  ip: string | undefined,
): Promise<AdminStoryResponse> {
  const { fileIds, status } = await prisma.$transaction(async (tx) => {
    // The story row is locked first, then the landing lists: the order a site content save uses.
    await tx.$queryRaw`SELECT id FROM story WHERE id = ${id}::uuid FOR UPDATE`;
    const current = await tx.story.findUnique({ where: { id } });
    if (!current) throw notFound("Story not found");

    const status = input.decision === "APPROVE" ? "APPROVED" : "REJECTED";
    if (current.status === status) {
      throw appError("StoryAlreadyModerated", 409, "This story already has that decision.");
    }

    // An approval has no note. A rejection keeps the admin's note and its visibility.
    const note = input.decision === "APPROVE" ? null : (input.note ?? null);
    const noteVisible = input.decision === "APPROVE" ? true : input.noteVisible;
    await tx.story.update({
      where: { id },
      data: {
        status,
        moderationNote: note,
        noteVisible,
        reviewedById: admin.accountId,
        decidedAt: new Date(),
      },
    });
    if (status === "REJECTED") {
      await removeSourceFromLanding(tx, { kind: "story", id }, admin.accountId);
    }

    await writeAudit(tx, {
      actorAccountId: admin.accountId,
      action: "story.moderate",
      entityType: "story",
      entityId: id,
      before: { status: current.status },
      after: { status, note, noteVisible },
      ip,
    });
    await tx.appNotification.create({
      data: {
        recipientId: current.accountId,
        kind: status === "APPROVED" ? "STORY_APPROVED" : "STORY_REJECTED",
        note: visibleNote(note, noteVisible),
      },
    });
    return {
      fileIds: [current.imageFileId, current.videoFileId].filter(
        (fileId): fileId is string => fileId !== null,
      ),
      status,
    };
  });

  // The copies change after the commit. A failed copy is logged and the story stays on signed URLs.
  for (const fileId of fileIds) {
    if (status === "APPROVED") await publishFile(fileId);
    else await unpublishFile(fileId);
  }
  return getAdminStory(id);
}
