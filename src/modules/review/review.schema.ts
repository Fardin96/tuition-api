import { z } from "zod";
import { ReviewDirection, ReviewStatus } from "../../generated/prisma/enums.js";

export const reviewIdParamSchema = z.object({ id: z.string().uuid() });
export type ReviewIdParam = z.infer<typeof reviewIdParamSchema>;

const ratingSchema = z.number().int().min(1).max(5);
const commentSchema = z.string().trim().min(1).max(1000);

export const createReviewSchema = z
  .object({
    applicationId: z.string().uuid(),
    rating: ratingSchema,
    comment: commentSchema.nullish(),
  })
  .strict()
  .meta({ id: "CreateReview" });
export type CreateReviewInput = z.infer<typeof createReviewSchema>;

export const updateReviewSchema = z
  .object({
    rating: ratingSchema.optional(),
    comment: commentSchema.nullable().optional(),
  })
  .strict()
  .refine((v) => v.rating !== undefined || v.comment !== undefined, {
    message: "Send a rating or a comment to change",
  })
  .meta({ id: "UpdateReview" });
export type UpdateReviewInput = z.infer<typeof updateReviewSchema>;

export const myReviewListQuerySchema = z.object({
  applicationId: z.string().uuid().optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type MyReviewListQuery = z.infer<typeof myReviewListQuerySchema>;

// Query of the public review lists.
export const reviewPageQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type ReviewPageQuery = z.infer<typeof reviewPageQuerySchema>;

// A review the caller wrote. subject is the person who was reviewed.
export const myReviewSchema = z
  .object({
    id: z.string(),
    direction: z.nativeEnum(ReviewDirection),
    rating: z.number().int(),
    comment: z.string().nullable(),
    status: z.nativeEnum(ReviewStatus),
    createdAt: z.date(),
    updatedAt: z.date(),
    editableUntil: z.date(),
    canEdit: z.boolean(),
    subject: z.object({
      kind: z.enum(["TUTOR", "STUDENT"]),
      id: z.string(),
      name: z.string(),
    }),
  })
  .meta({ id: "MyReview" });
export type MyReviewResponse = z.infer<typeof myReviewSchema>;

export const myReviewPageSchema = z
  .object({
    reviews: z.array(myReviewSchema),
    nextCursor: z.string().nullable(),
  })
  .meta({ id: "MyReviewPage" });
export type MyReviewPageResponse = z.infer<typeof myReviewPageSchema>;

// Rating figures of a public review list, from VISIBLE rows only.
export const reviewSummarySchema = z
  .object({
    ratingAvg: z.number(),
    ratingCount: z.number().int(),
    breakdown: z.object({
      "1": z.number().int(),
      "2": z.number().int(),
      "3": z.number().int(),
      "4": z.number().int(),
      "5": z.number().int(),
    }),
  })
  .meta({ id: "ReviewSummary" });
export type ReviewSummaryResponse = z.infer<typeof reviewSummarySchema>;
