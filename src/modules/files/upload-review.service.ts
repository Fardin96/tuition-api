import type {
  AppNotificationKind,
  FileAsset,
  FilePurpose,
  Prisma,
  UploadBlock,
  UploadReviewAction,
} from "../../generated/prisma/client.js";
import { appError } from "../../lib/errors.js";
import type { prisma } from "../../lib/prisma.js";

// Upload moderation shared by the admin verification, video, file and block endpoints: the
// per-user history (upload_review), upload blocks (upload_block), and upload alerts in the bell.
// Every write here takes the caller's transaction, so the decision, its history row and the alert
// commit together.

type Db = Prisma.TransactionClient | typeof prisma;

/** Rejections, revocations and removals in this window count toward the repeat warning. */
export const ISSUE_WINDOW_DAYS = 30;
/** Admins see a "repeated problems" warning at this many issues in the window. */
export const REPEAT_ISSUE_THRESHOLD = 3;
export const ISSUE_ACTIONS: UploadReviewAction[] = ["REJECTED", "REVOKED", "REMOVED"];

/** The note the user may see: the note when the admin shared it, else null. */
export function visibleNote(note: string | null, noteVisible: boolean): string | null {
  return noteVisible ? note : null;
}

export type UploadCategory = "VIDEOS" | "DOCUMENTS";

/** Which block switch covers a purpose. Blog covers are admin uploads and are never blocked. */
export function uploadCategory(purpose: FilePurpose): UploadCategory | null {
  if (purpose === "TUTOR_VIDEO") return "VIDEOS";
  if (purpose === "BLOG_COVER") return null;
  return "DOCUMENTS";
}

/** The account's active block, or null. */
export function activeUploadBlock(db: Db, accountId: string): Promise<UploadBlock | null> {
  return db.uploadBlock.findFirst({ where: { accountId, unblockedAt: null } });
}

/**
 * 403 UPLOADS_BLOCKED when an active block covers this purpose. Checked when an upload starts and
 * again when a file is attached, so a block placed mid-upload still holds.
 */
export async function assertUploadsAllowed(
  db: Db,
  accountId: string,
  purpose: FilePurpose,
): Promise<void> {
  const category = uploadCategory(purpose);
  if (!category) return;
  const block = await activeUploadBlock(db, accountId);
  if (!block) return;
  const blocked = category === "VIDEOS" ? block.blocksVideos : block.blocksDocuments;
  if (!blocked) return;
  const what = category === "VIDEOS" ? "video uploads" : "ID and certificate uploads";
  throw appError("UploadsBlocked", 403, `An admin has paused your ${what}.`, {
    category,
    note: visibleNote(block.note, block.noteVisible),
  });
}

/** Appends one history row. File details are copied so the row outlives the file. */
export async function recordUploadReview(
  tx: Prisma.TransactionClient,
  input: {
    accountId: string;
    file: Pick<FileAsset, "id" | "purpose" | "originalName" | "contentType" | "sizeBytes"> | null;
    action: UploadReviewAction;
    note: string | null;
    noteVisible: boolean;
    actorAccountId: string;
  },
): Promise<void> {
  await tx.uploadReview.create({
    data: {
      accountId: input.accountId,
      fileId: input.file?.id ?? null,
      purpose: input.file?.purpose ?? null,
      fileName: input.file?.originalName ?? null,
      contentType: input.file?.contentType ?? null,
      sizeBytes: input.file?.sizeBytes ?? null,
      action: input.action,
      note: input.note,
      noteVisible: input.noteVisible,
      actorAccountId: input.actorAccountId,
    },
  });
}

/** An upload alert in the user's bell. `note` is stored only when the admin shared it. */
export async function notifyUpload(
  tx: Prisma.TransactionClient,
  input: {
    recipientId: string;
    kind: Extract<
      AppNotificationKind,
      | "ID_APPROVED"
      | "ID_REJECTED"
      | "VIDEO_APPROVED"
      | "VIDEO_REJECTED"
      | "FILE_REMOVED"
      | "UPLOADS_BLOCKED"
      | "UPLOADS_UNBLOCKED"
    >;
    note: string | null;
    noteVisible: boolean;
    filePurpose?: FilePurpose | null;
    blocksVideos?: boolean | null;
    blocksDocuments?: boolean | null;
  },
): Promise<void> {
  await tx.appNotification.create({
    data: {
      recipientId: input.recipientId,
      kind: input.kind,
      note: visibleNote(input.note, input.noteVisible),
      filePurpose: input.filePurpose ?? null,
      blocksVideos: input.blocksVideos ?? null,
      blocksDocuments: input.blocksDocuments ?? null,
    },
  });
}

export type UploadFlags = { recentIssues: number; uploadsBlocked: boolean };

/**
 * For admin queues: per account, the rejections, revocations and removals in the last
 * ISSUE_WINDOW_DAYS, and whether any upload block is active. Accounts with neither get zeros.
 */
export async function uploadFlagsFor(
  db: Db,
  accountIds: string[],
  now = new Date(),
): Promise<Map<string, UploadFlags>> {
  const ids = [...new Set(accountIds)];
  const flags = new Map<string, UploadFlags>(
    ids.map((id) => [id, { recentIssues: 0, uploadsBlocked: false }]),
  );
  if (ids.length === 0) return flags;
  const since = new Date(now.getTime() - ISSUE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const issues = await db.uploadReview.groupBy({
    by: ["accountId"],
    where: { accountId: { in: ids }, action: { in: ISSUE_ACTIONS }, createdAt: { gte: since } },
    _count: { _all: true },
  });
  for (const row of issues) {
    const entry = flags.get(row.accountId);
    if (entry) entry.recentIssues = row._count._all;
  }
  const blocks = await db.uploadBlock.findMany({
    where: { accountId: { in: ids }, unblockedAt: null },
    select: { accountId: true },
  });
  for (const row of blocks) {
    const entry = flags.get(row.accountId);
    if (entry) entry.uploadsBlocked = true;
  }
  return flags;
}
