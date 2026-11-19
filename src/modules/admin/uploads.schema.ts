import { z } from "zod";
import { FilePurpose, UploadReviewAction } from "../../generated/prisma/enums.js";
import { noteVisibleSchema, reviewNoteSchema } from "../files/upload-review.schema.js";

export const uploadAccountParamSchema = z.object({ accountId: z.string().uuid() });
export type UploadAccountParam = z.infer<typeof uploadAccountParamSchema>;

export const uploadHistoryQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type UploadHistoryQuery = z.infer<typeof uploadHistoryQuerySchema>;

// An admin named on a history row or a block. accountId is the admin's account.
const uploadActorSchema = z.object({ accountId: z.string(), name: z.string() }).meta({
  id: "UploadActor",
});

export const uploadBlockViewSchema = z
  .object({
    id: z.string(),
    blocksVideos: z.boolean(),
    blocksDocuments: z.boolean(),
    note: z.string(),
    noteVisible: z.boolean(),
    blockedAt: z.date(),
    blockedBy: uploadActorSchema.nullable(),
  })
  .meta({ id: "UploadBlockView" });
export type UploadBlockView = z.infer<typeof uploadBlockViewSchema>;

export const uploadReviewEventSchema = z
  .object({
    id: z.string(),
    action: z.nativeEnum(UploadReviewAction),
    purpose: z.nativeEnum(FilePurpose).nullable(),
    fileName: z.string().nullable(),
    contentType: z.string().nullable(),
    sizeBytes: z.number().int().nullable(),
    fileId: z.string().nullable(),
    /** The file still exists and finished uploading, so an admin can open it. */
    fileAvailable: z.boolean(),
    note: z.string().nullable(),
    noteVisible: z.boolean(),
    actor: uploadActorSchema.nullable(),
    createdAt: z.date(),
  })
  .meta({ id: "UploadReviewEvent" });
export type UploadReviewEvent = z.infer<typeof uploadReviewEventSchema>;

export const uploadHistorySchema = z
  .object({
    block: uploadBlockViewSchema.nullable(),
    summary: z.object({
      /** Rejections, revocations and removals in the last windowDays. */
      recentIssues: z.number().int(),
      /** Every upload_review row for the account. */
      total: z.number().int(),
      windowDays: z.number().int(),
      /** recentIssues at or above this shows the repeated-problems warning. */
      threshold: z.number().int(),
    }),
    events: z.array(uploadReviewEventSchema),
    nextCursor: z.string().nullable(),
  })
  .meta({ id: "UploadHistory" });
export type UploadHistory = z.infer<typeof uploadHistorySchema>;

export const uploadBlockBodySchema = z
  .object({
    blocksVideos: z.boolean(),
    blocksDocuments: z.boolean(),
    note: reviewNoteSchema,
    noteVisible: noteVisibleSchema,
  })
  .strict()
  .refine((body) => body.blocksVideos || body.blocksDocuments, {
    message: "Pick videos, documents or both.",
    path: ["blocksVideos"],
  });
export type UploadBlockInput = z.infer<typeof uploadBlockBodySchema>;

// The body may be omitted entirely (Fastify then passes null): the route reads that as {}.
export const liftUploadBlockSchema = z
  .object({
    note: reviewNoteSchema.optional(),
    noteVisible: noteVisibleSchema,
  })
  .strict()
  .nullish();
export type LiftUploadBlockInput = NonNullable<z.infer<typeof liftUploadBlockSchema>>;
