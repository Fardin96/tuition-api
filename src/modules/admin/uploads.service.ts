import type { Prisma } from "../../generated/prisma/client.js";
import { writeAudit } from "../../lib/admin.js";
import { decodeCursor, encodeCursor } from "../../lib/cursor.js";
import { appError, notFound } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import {
  activeUploadBlock,
  ISSUE_WINDOW_DAYS,
  notifyUpload,
  REPEAT_ISSUE_THRESHOLD,
  recordUploadReview,
  uploadFlagsFor,
  visibleNote,
} from "../files/upload-review.service.js";
import type {
  LiftUploadBlockInput,
  UploadBlockInput,
  UploadBlockView,
  UploadHistory,
  UploadHistoryQuery,
  UploadReviewEvent,
} from "./uploads.schema.js";

// Per-account upload history, upload blocks, and the user's own pause status. Each write runs in
// one transaction with its audit row, history row and alert; the account row is locked first so
// two admins acting on the same account run one after the other.

const blockInclude = {
  blockedBy: { select: { name: true } },
} satisfies Prisma.UploadBlockInclude;

type BlockRow = Prisma.UploadBlockGetPayload<{ include: typeof blockInclude }>;

function toBlockView(row: BlockRow): UploadBlockView {
  return {
    id: row.id,
    blocksVideos: row.blocksVideos,
    blocksDocuments: row.blocksDocuments,
    note: row.note,
    noteVisible: row.noteVisible,
    blockedAt: row.blockedAt,
    blockedBy:
      row.blockedById && row.blockedBy
        ? { accountId: row.blockedById, name: row.blockedBy.name }
        : null,
  };
}

const eventInclude = {
  actor: { select: { name: true } },
  file: { select: { status: true } },
} satisfies Prisma.UploadReviewInclude;

type EventRow = Prisma.UploadReviewGetPayload<{ include: typeof eventInclude }>;

function toEvent(row: EventRow): UploadReviewEvent {
  return {
    id: row.id,
    action: row.action,
    purpose: row.purpose,
    fileName: row.fileName,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    fileId: row.fileId,
    fileAvailable: row.file?.status === "UPLOADED",
    note: row.note,
    noteVisible: row.noteVisible,
    actor:
      row.actorAccountId && row.actor
        ? { accountId: row.actorAccountId, name: row.actor.name }
        : null,
    createdAt: row.createdAt,
  };
}

async function requireAccount(db: Prisma.TransactionClient | typeof prisma, accountId: string) {
  const account = await db.account.findUnique({
    where: { id: accountId },
    select: { id: true, role: true },
  });
  if (!account) throw notFound("Account not found");
  return account;
}

// Newest first. Keyset pagination over (created_at, id).
export async function getUploadHistory(
  accountId: string,
  query: UploadHistoryQuery,
): Promise<UploadHistory> {
  await requireAccount(prisma, accountId);
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;

  const [block, total, flags, rows] = await Promise.all([
    prisma.uploadBlock.findFirst({
      where: { accountId, unblockedAt: null },
      include: blockInclude,
    }),
    prisma.uploadReview.count({ where: { accountId } }),
    uploadFlagsFor(prisma, [accountId]),
    prisma.uploadReview.findMany({
      where: {
        accountId,
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
      include: eventInclude,
    }),
  ]);

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];

  return {
    block: block ? toBlockView(block) : null,
    summary: {
      recentIssues: flags.get(accountId)?.recentIssues ?? 0,
      total,
      windowDays: ISSUE_WINDOW_DAYS,
      threshold: REPEAT_ISSUE_THRESHOLD,
    },
    events: page.map(toEvent),
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
  };
}

/**
 * Creates the account's active block, or updates it when one is open. The block keeps its
 * original blockedAt and blockedBy; each change is in the audit log and the history.
 */
export async function setUploadBlock(
  accountId: string,
  input: UploadBlockInput,
  caller: { accountId: string },
  ip: string | undefined,
): Promise<UploadBlockView> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM account WHERE id = ${accountId}::uuid FOR UPDATE`;
    const account = await requireAccount(tx, accountId);
    if (account.role === "ADMIN") {
      throw appError("ValidationError", 400, "Admin accounts can't be blocked from uploads.");
    }

    const previous = await activeUploadBlock(tx, accountId);
    const block = previous
      ? await tx.uploadBlock.update({
          where: { id: previous.id },
          data: {
            blocksVideos: input.blocksVideos,
            blocksDocuments: input.blocksDocuments,
            note: input.note,
            noteVisible: input.noteVisible,
          },
          include: blockInclude,
        })
      : await tx.uploadBlock.create({
          data: {
            accountId,
            blocksVideos: input.blocksVideos,
            blocksDocuments: input.blocksDocuments,
            note: input.note,
            noteVisible: input.noteVisible,
            blockedById: caller.accountId,
          },
          include: blockInclude,
        });

    await writeAudit(tx, {
      actorAccountId: caller.accountId,
      action: "uploads.block",
      entityType: "account",
      entityId: accountId,
      before: previous
        ? {
            blocksVideos: previous.blocksVideos,
            blocksDocuments: previous.blocksDocuments,
            note: previous.note,
            noteVisible: previous.noteVisible,
          }
        : null,
      after: {
        blocksVideos: input.blocksVideos,
        blocksDocuments: input.blocksDocuments,
        note: input.note,
        noteVisible: input.noteVisible,
      },
      ip,
    });
    await recordUploadReview(tx, {
      accountId,
      file: null,
      action: "BLOCKED",
      note: input.note,
      noteVisible: input.noteVisible,
      actorAccountId: caller.accountId,
    });
    await notifyUpload(tx, {
      recipientId: accountId,
      kind: "UPLOADS_BLOCKED",
      note: input.note,
      noteVisible: input.noteVisible,
      blocksVideos: input.blocksVideos,
      blocksDocuments: input.blocksDocuments,
    });

    return toBlockView(block);
  });
}

/** Closes the active block. 404 when nothing is blocked. The note is optional. */
export async function liftUploadBlock(
  accountId: string,
  input: LiftUploadBlockInput,
  caller: { accountId: string },
  ip: string | undefined,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM account WHERE id = ${accountId}::uuid FOR UPDATE`;
    await requireAccount(tx, accountId);
    const block = await activeUploadBlock(tx, accountId);
    if (!block) {
      throw notFound("No active upload block");
    }

    await tx.uploadBlock.update({
      where: { id: block.id },
      data: { unblockedAt: new Date(), unblockedById: caller.accountId },
    });

    const note = input.note ?? null;
    await writeAudit(tx, {
      actorAccountId: caller.accountId,
      action: "uploads.unblock",
      entityType: "account",
      entityId: accountId,
      before: {
        blocksVideos: block.blocksVideos,
        blocksDocuments: block.blocksDocuments,
        note: block.note,
      },
      after: { note, noteVisible: input.noteVisible },
      ip,
    });
    await recordUploadReview(tx, {
      accountId,
      file: null,
      action: "UNBLOCKED",
      note,
      noteVisible: input.noteVisible,
      actorAccountId: caller.accountId,
    });
    await notifyUpload(tx, {
      recipientId: accountId,
      kind: "UPLOADS_UNBLOCKED",
      note,
      noteVisible: input.noteVisible,
    });
  });
}

/** What the signed-in account sees about its own pause. The note appears only when shared. */
export async function getUploadStatus(accountId: string) {
  const block = await activeUploadBlock(prisma, accountId);
  if (!block) {
    return { blocksVideos: false, blocksDocuments: false, note: null, blockedAt: null };
  }
  return {
    blocksVideos: block.blocksVideos,
    blocksDocuments: block.blocksDocuments,
    note: visibleNote(block.note, block.noteVisible),
    blockedAt: block.blockedAt,
  };
}
