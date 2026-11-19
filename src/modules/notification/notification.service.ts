import type { Prisma } from "../../generated/prisma/client.js";
import { decodeCursor, encodeCursor } from "../../lib/cursor.js";
import { notFound } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import type { AuthContext } from "../auth/auth.schema.js";
import type {
  AppNotificationResponse,
  NotificationListQuery,
  NotificationPageResponse,
} from "./notification.schema.js";

const DEFAULT_LIMIT = 20;

const notificationInclude = {
  application: {
    select: {
      requirementId: true,
      tutor: { select: { accountId: true, name: true } },
      student: { select: { accountId: true, name: true } },
    },
  },
} satisfies Prisma.AppNotificationInclude;

type NotificationRow = Prisma.AppNotificationGetPayload<{ include: typeof notificationInclude }>;

function toNotification(row: NotificationRow, accountId: string): AppNotificationResponse {
  const { application } = row;
  // Upload alerts have no application. The recipient is either the tutor or the student on the
  // application; the other one is the counterpart.
  const recipientIsTutor = application?.tutor.accountId === accountId;
  return {
    id: row.id,
    kind: row.kind,
    applicationId: row.applicationId,
    listingKind: application ? (application.requirementId ? "REQUIREMENT" : "PACKAGE") : null,
    counterpartName: application
      ? recipientIsTutor
        ? application.student.name
        : application.tutor.name
      : null,
    // Stored only when the admin shared it, so no visibility check is needed here.
    note: row.note,
    filePurpose: row.filePurpose,
    blocksVideos: row.blocksVideos,
    blocksDocuments: row.blocksDocuments,
    readAt: row.readAt,
    createdAt: row.createdAt,
  };
}

function countUnread(accountId: string): Promise<number> {
  return prisma.appNotification.count({ where: { recipientId: accountId, readAt: null } });
}

// Keyset page over (createdAt desc, id desc). Every caller sees only the rows addressed to them.
export async function listNotifications(
  account: AuthContext,
  query: NotificationListQuery,
): Promise<NotificationPageResponse> {
  const limit = query.limit ?? DEFAULT_LIMIT;
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;

  const rows = await prisma.appNotification.findMany({
    where: {
      AND: [
        { recipientId: account.accountId },
        cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {},
      ],
    },
    include: notificationInclude,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  return {
    notifications: page.map((row) => toNotification(row, account.accountId)),
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
    unreadCount: await countUnread(account.accountId),
  };
}

export async function unreadCountFor(account: AuthContext): Promise<{ count: number }> {
  return { count: await countUnread(account.accountId) };
}

// Idempotent: an alert that is already read stays read. Someone else's or an unknown id is 404.
export async function markNotificationRead(account: AuthContext, id: string): Promise<void> {
  const { count } = await prisma.appNotification.updateMany({
    where: { id, recipientId: account.accountId, readAt: null },
    data: { readAt: new Date() },
  });
  if (count > 0) return;

  const own = await prisma.appNotification.findFirst({
    where: { id, recipientId: account.accountId },
    select: { id: true },
  });
  if (!own) throw notFound("Notification not found");
}

export async function markAllNotificationsRead(account: AuthContext): Promise<void> {
  await prisma.appNotification.updateMany({
    where: { recipientId: account.accountId, readAt: null },
    data: { readAt: new Date() },
  });
}
