import { z } from "zod";
import { VerificationStatus } from "../../generated/prisma/enums.js";
import { fileAssetSchema } from "../files/files.schema.js";

// Review queues. PENDING is oldest first; APPROVED and REJECTED are newest first.
const reviewStatus = z.enum(["PENDING", "APPROVED", "REJECTED"]);

export const verificationIdParamSchema = z.object({ id: z.string().uuid() });
export type VerificationIdParam = z.infer<typeof verificationIdParamSchema>;

export const verificationListQuerySchema = z.object({
  status: reviewStatus.default("PENDING"),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type VerificationListQuery = z.infer<typeof verificationListQuerySchema>;

export const adminTutorVerificationSchema = z
  .object({
    id: z.string(),
    status: z.nativeEnum(VerificationStatus),
    submittedAt: z.date(),
    decidedAt: z.date().nullable(),
    note: z.string().nullable(),
    reviewedById: z.string().nullable(),
    file: fileAssetSchema,
    tutor: z.object({
      id: z.string(),
      accountId: z.string(),
      name: z.string(),
      instituteName: z.string().nullable(),
      studentIdNumber: z.string().nullable(),
      verificationStatus: z.nativeEnum(VerificationStatus),
    }),
  })
  .meta({ id: "AdminTutorVerification" });
export type AdminTutorVerificationResponse = z.infer<typeof adminTutorVerificationSchema>;

export const adminTutorVerificationPageSchema = z
  .object({
    verifications: z.array(adminTutorVerificationSchema),
    nextCursor: z.string().nullable(),
  })
  .meta({ id: "AdminTutorVerificationPage" });
export type AdminTutorVerificationPageResponse = z.infer<typeof adminTutorVerificationPageSchema>;

export const adminStudentVerificationSchema = z
  .object({
    studentId: z.string(),
    status: z.nativeEnum(VerificationStatus),
    submittedAt: z.date().nullable(),
    decidedAt: z.date().nullable(),
    note: z.string().nullable(),
    reviewedById: z.string().nullable(),
    file: fileAssetSchema.nullable(),
    student: z.object({
      id: z.string(),
      accountId: z.string(),
      name: z.string(),
      studentIdNumber: z.string(),
    }),
  })
  .meta({ id: "AdminStudentVerification" });
export type AdminStudentVerificationResponse = z.infer<typeof adminStudentVerificationSchema>;

export const adminStudentVerificationPageSchema = z
  .object({
    verifications: z.array(adminStudentVerificationSchema),
    nextCursor: z.string().nullable(),
  })
  .meta({ id: "AdminStudentVerificationPage" });
export type AdminStudentVerificationPageResponse = z.infer<
  typeof adminStudentVerificationPageSchema
>;

// Notes are required to reject, so the tutor or student can see why.
export const decideVerificationSchema = z
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
        message: "Tell them why the ID was rejected",
      });
    }
  })
  .meta({ id: "DecideVerification" });
export type DecideVerificationInput = z.infer<typeof decideVerificationSchema>;
