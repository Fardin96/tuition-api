import { z } from "zod";
import { AppNotificationKind, FilePurpose } from "../../generated/prisma/enums.js";

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
    /** Null for upload alerts, which are not about an application. */
    applicationId: z.string().nullable(),
    /** The requirement an invite is about (REQUIREMENT_INVITED alerts only). Null otherwise. */
    requirementId: z.string().nullable(),
    /** Picks the wording: a tuition (requirement) or a package. Null for upload alerts. */
    listingKind: z.enum(["REQUIREMENT", "PACKAGE"]).nullable(),
    /**
     * The other party, as the recipient sees them: the student on an invite, the other side of an
     * application. Null for upload alerts.
     */
    counterpartName: z.string().nullable(),
    /** The admin's note, only when it was shared with the user. Null otherwise. */
    note: z.string().nullable(),
    /** The upload the alert is about (upload alerts only). */
    filePurpose: z.nativeEnum(FilePurpose).nullable(),
    /** Upload block alerts only: which uploads the block covers. */
    blocksVideos: z.boolean().nullable(),
    blocksDocuments: z.boolean().nullable(),
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
