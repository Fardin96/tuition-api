import { z } from "zod";
import {
  ListingStatus,
  ModerationStatus,
  VerificationStatus,
} from "../../generated/prisma/enums.js";
import { packageSchema } from "../package/package.schema.js";

// The package as students see it, plus what the review needs: the moderation note, the last edit and
// the tutor's verification and listing state.
export const adminPackageSchema = packageSchema
  .extend({
    moderationNote: z.string().nullable(),
    updatedAt: z.date(),
    tutor: packageSchema.shape.tutor.extend({
      verificationStatus: z.nativeEnum(VerificationStatus),
      isListed: z.boolean(),
    }),
  })
  .meta({ id: "AdminPackage" });
export type AdminPackageResponse = z.infer<typeof adminPackageSchema>;

export const adminPackageListQuerySchema = z.object({
  moderationStatus: z.nativeEnum(ModerationStatus).default("PENDING"),
  status: z.nativeEnum(ListingStatus).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type AdminPackageListQuery = z.infer<typeof adminPackageListQuerySchema>;

export const adminPackagePageSchema = z
  .object({
    packages: z.array(adminPackageSchema),
    nextCursor: z.string().nullable(),
  })
  .meta({ id: "AdminPackagePage" });
export type AdminPackagePageResponse = z.infer<typeof adminPackagePageSchema>;

export const moderatePackageSchema = z
  .object({
    decision: z.enum(["APPROVE", "REJECT"]),
    note: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.decision === "REJECT" && v.note === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["note"],
        message: "Tell the tutor why the package was rejected",
      });
    }
  })
  .meta({ id: "ModeratePackage" });
export type ModeratePackageInput = z.infer<typeof moderatePackageSchema>;
