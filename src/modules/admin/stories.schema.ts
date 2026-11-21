import { z } from "zod";
import { ModerationStatus, Role } from "../../generated/prisma/enums.js";
import { noteVisibleSchema, reviewNoteSchema } from "../files/upload-review.schema.js";

export const storyIdParamSchema = z.object({ id: z.string().uuid() });
export type StoryIdParam = z.infer<typeof storyIdParamSchema>;

export const adminStoryListQuerySchema = z.object({
  status: z.nativeEnum(ModerationStatus).default("PENDING"),
  role: z.nativeEnum(Role).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type AdminStoryListQuery = z.infer<typeof adminStoryListQuerySchema>;

const adminStoryMediaSchema = z
  .object({
    url: z.string().nullable(),
    contentType: z.string(),
    originalName: z.string().nullable(),
  })
  .meta({ id: "AdminStoryMedia" });

// The story as the review needs it. note is the admin's own note; noteVisible says whether the author sees it.
export const adminStorySchema = z
  .object({
    id: z.string(),
    author: z.object({
      accountId: z.string(),
      name: z.string(),
      role: z.nativeEnum(Role),
    }),
    role: z.nativeEnum(Role),
    headline: z.string().nullable(),
    body: z.string(),
    status: z.nativeEnum(ModerationStatus),
    note: z.string().nullable(),
    noteVisible: z.boolean(),
    image: adminStoryMediaSchema.nullable(),
    video: adminStoryMediaSchema.nullable(),
    consentAt: z.date(),
    createdAt: z.date(),
    decidedAt: z.date().nullable(),
    /** A testimonials or showcase card on the landing page uses this story now. */
    onLanding: z.boolean(),
  })
  .meta({ id: "AdminStory" });
export type AdminStoryResponse = z.infer<typeof adminStorySchema>;

export const adminStoryPageSchema = z
  .object({
    stories: z.array(adminStorySchema),
    nextCursor: z.string().nullable(),
  })
  .meta({ id: "AdminStoryPage" });
export type AdminStoryPageResponse = z.infer<typeof adminStoryPageSchema>;

export const moderateStorySchema = z
  .object({
    decision: z.enum(["APPROVE", "REJECT"]),
    note: reviewNoteSchema.optional(),
    noteVisible: noteVisibleSchema,
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.decision === "REJECT" && v.note === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["note"],
        message: "Tell the author why the story was rejected",
      });
    }
  })
  .meta({ id: "ModerateStory" });
export type ModerateStoryInput = z.infer<typeof moderateStorySchema>;
