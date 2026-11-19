import { z } from "zod";

/** An admin's note on an upload decision, removal or block. */
export const reviewNoteSchema = z.string().trim().min(3).max(500);

/** Whether the user sees the admin's note. Hidden notes stay between admins. */
export const noteVisibleSchema = z.boolean().default(true);

// Shown on admin queue rows: problems with this user's uploads lately, and whether a block is on.
export const uploadFlagsSchema = z
  .object({
    /** Rejections, revocations and removals in the last 30 days. */
    recentIssues: z.number().int(),
    uploadsBlocked: z.boolean(),
  })
  .meta({ id: "UploadFlags" });
