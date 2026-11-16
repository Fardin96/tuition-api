import { z } from "zod";
import { AppNotificationKind } from "../../generated/prisma/enums.js";

export const notificationIdParamSchema = z.object({ id: z.string().uuid() });
export type NotificationIdParam = z.infer<typeof notificationIdParamSchema>;

export const notificationListQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});
export type NotificationListQuery = z.infer<typeof notificationListQuerySchema>;

export const appNotificationSchema = z
  .object({
    id: z.string(),
    kind: z.nativeEnum(AppNotificationKind),
    applicationId: z.string(),
    /** Picks the wording: a tuition (requirement) or a package. */
    listingKind: z.enum(["REQUIREMENT", "PACKAGE"]),
    /** The other party of the application, as the recipient sees them. */
    counterpartName: z.string(),
    readAt: z.date().nullable(),
    createdAt: z.date(),
  })
  .meta({ id: "AppNotification" });
export type AppNotificationResponse = z.infer<typeof appNotificationSchema>;

export const notificationPageSchema = z
  .object({
    notifications: z.array(appNotificationSchema),
    nextCursor: z.string().nullable(),
    /** Unread alerts for the caller, across all pages. */
    unreadCount: z.number().int(),
  })
  .meta({ id: "NotificationPage" });
export type NotificationPageResponse = z.infer<typeof notificationPageSchema>;

export const unreadCountSchema = z.object({ count: z.number().int() }).meta({ id: "UnreadCount" });
