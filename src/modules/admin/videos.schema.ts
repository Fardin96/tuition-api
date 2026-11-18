import { z } from "zod";
import { ModerationStatus, VerificationStatus } from "../../generated/prisma/enums.js";
import { fileAssetSchema } from "../files/files.schema.js";

export const videoIdParamSchema = z.object({ id: z.string().uuid() });
export type VideoIdParam = z.infer<typeof videoIdParamSchema>;

export const adminVideoListQuerySchema = z.object({
  status: z.nativeEnum(ModerationStatus).default("PENDING"),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type AdminVideoListQuery = z.infer<typeof adminVideoListQuerySchema>;

// The video as the review needs it. url is the public link once approved, else a signed link.
export const adminVideoSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    status: z.nativeEnum(ModerationStatus),
    moderationNote: z.string().nullable(),
    sortOrder: z.number().int(),
    createdAt: z.date(),
    url: z.string().nullable(),
    file: fileAssetSchema,
    tutor: z.object({
      id: z.string(),
      name: z.string(),
      verificationStatus: z.nativeEnum(VerificationStatus),
    }),
  })
  .meta({ id: "AdminVideo" });
export type AdminVideoResponse = z.infer<typeof adminVideoSchema>;

export const adminVideoPageSchema = z
  .object({
    videos: z.array(adminVideoSchema),
    nextCursor: z.string().nullable(),
  })
  .meta({ id: "AdminVideoPage" });
export type AdminVideoPageResponse = z.infer<typeof adminVideoPageSchema>;

export const moderateVideoSchema = z
  .object({
    decision: z.enum(["APPROVE", "REJECT"]),
    note: z.string().trim().min(3).max(500).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.decision === "REJECT" && v.note === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["note"],
        message: "Tell the tutor why the video was rejected",
      });
    }
  })
  .meta({ id: "ModerateVideo" });
export type ModerateVideoInput = z.infer<typeof moderateVideoSchema>;

export const updateVideoSchema = z
  .object({ sortOrder: z.number().int().min(0).max(10000) })
  .strict()
  .meta({ id: "UpdateVideo" });
export type UpdateVideoInput = z.infer<typeof updateVideoSchema>;
