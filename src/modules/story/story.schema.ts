import { z } from "zod";
import { ModerationStatus, Role } from "../../generated/prisma/enums.js";
import { fileIdSchema } from "../files/files.schema.js";

// A story is a testimonial a student or tutor sends in. Limits are per account and cover every status.
export const MAX_STORIES = 3;
export const STORY_HEADLINE_CHARS = 85;
export const STORY_BODY_CHARS = 700;
export const STORY_BODY_WORDS = 90;
export const TUTOR_STORY_BODY_CHARS = 300;

export const storyIdParamSchema = z.object({ id: z.string().uuid() });
export type StoryIdParam = z.infer<typeof storyIdParamSchema>;

const headline = z
  .string()
  .trim()
  .min(1, "Required")
  .max(STORY_HEADLINE_CHARS, `At most ${STORY_HEADLINE_CHARS} characters`)
  .refine((v) => !/[\r\n]/.test(v), "Keep this on one line");

// Students and tutors share one body: the word limit and the tutor length cap are checked in the service,
// because they depend on the caller's role.
const body = z
  .string()
  .trim()
  .min(1, "Required")
  .max(STORY_BODY_CHARS, `At most ${STORY_BODY_CHARS} characters`);

export const createStorySchema = z
  .object({
    /** Students only. */
    headline: headline.optional(),
    body,
    imageFileId: fileIdSchema.optional(),
    /** Students only. */
    videoFileId: fileIdSchema.optional(),
    consent: z.literal(true, { message: "Confirm that you agree to publication" }),
  })
  .meta({ id: "CreateStory" });
export type CreateStoryInput = z.infer<typeof createStorySchema>;

const storyMediaSchema = z
  .object({ url: z.string().nullable(), contentType: z.string() })
  .meta({ id: "StoryMedia" });

// What the author sees. note is null unless the admin shared it.
export const storySchema = z
  .object({
    id: z.string(),
    role: z.nativeEnum(Role),
    headline: z.string().nullable(),
    body: z.string(),
    status: z.nativeEnum(ModerationStatus),
    note: z.string().nullable(),
    image: storyMediaSchema.nullable(),
    video: storyMediaSchema.nullable(),
    createdAt: z.date(),
    decidedAt: z.date().nullable(),
    /** A testimonials or showcase card on the landing page uses this story now. */
    onLanding: z.boolean(),
  })
  .meta({ id: "Story" });
export type StoryResponse = z.infer<typeof storySchema>;

export const storyListSchema = z
  .object({
    stories: z.array(storySchema),
    max: z.number().int(),
    /** False while the account is at the limit or has a story pending review. */
    canSubmit: z.boolean(),
    blockedReason: z.enum(["LIMIT", "PENDING"]).nullable(),
  })
  .meta({ id: "StoryList" });
export type StoryListResponse = z.infer<typeof storyListSchema>;
