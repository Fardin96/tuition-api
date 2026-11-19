import { z } from "zod";
import { ReviewDirection, ReviewStatus } from "../../generated/prisma/enums.js";

export const reviewIdParamSchema = z.object({ id: z.string().uuid() });
export type ReviewIdParam = z.infer<typeof reviewIdParamSchema>;

export const adminReviewListQuerySchema = z.object({
  status: z.nativeEnum(ReviewStatus).optional(),
  direction: z.nativeEnum(ReviewDirection).optional(),
  tutorId: z.string().uuid().optional(),
  studentId: z.string().uuid().optional(),
  rating: z.coerce.number().int().min(1).max(5).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type AdminReviewListQuery = z.infer<typeof adminReviewListQuerySchema>;

const reviewPartySchema = z.object({
  id: z.string(),
  accountId: z.string(),
  name: z.string(),
});

export const adminReviewSchema = z
  .object({
    id: z.string(),
    direction: z.nativeEnum(ReviewDirection),
    rating: z.number().int(),
    comment: z.string().nullable(),
    status: z.nativeEnum(ReviewStatus),
    createdAt: z.date(),
    updatedAt: z.date(),
    tutor: reviewPartySchema,
    student: reviewPartySchema,
  })
  .meta({ id: "AdminReview" });
export type AdminReviewResponse = z.infer<typeof adminReviewSchema>;

export const adminReviewPageSchema = z
  .object({
    reviews: z.array(adminReviewSchema),
    nextCursor: z.string().nullable(),
  })
  .meta({ id: "AdminReviewPage" });
export type AdminReviewPageResponse = z.infer<typeof adminReviewPageSchema>;

export const moderateReviewSchema = z
  .object({
    status: z.enum(["VISIBLE", "HIDDEN"]),
    note: z.string().trim().min(3).max(500),
  })
  .strict()
  .meta({ id: "ModerateReview" });
export type ModerateReviewInput = z.infer<typeof moderateReviewSchema>;
