import { z } from "zod";
import { VerificationStatus } from "../../generated/prisma/enums.js";
import { locationSchema, ownLocationResponseSchema } from "../location/location.schema.js";

export const studentProfileSchema = z
  .object({
    name: z.string().min(1).max(200),
    areaId: z.coerce.number().int().positive(),
    address: z.string().min(1).max(500),
    emergencyContact: z.string().min(1).max(50),
    phoneNumber: z
      .string()
      .min(1)
      .max(20)
      .refine((v) => !v.startsWith("deleted:"), "Invalid number"),
    whatsappNumber: z
      .string()
      .min(1)
      .max(20)
      .refine((v) => !v.startsWith("deleted:"), "Invalid number")
      .nullable()
      .optional(),
    studentIdNumber: z.string().min(1).max(100),
    location: locationSchema.optional(),
  })
  .meta({ id: "CreateStudentProfile" });

export type StudentProfileInput = z.infer<typeof studentProfileSchema>;

export const updateStudentProfileSchema = studentProfileSchema
  .partial()
  .meta({ id: "UpdateStudentProfile" });

export type UpdateStudentProfileInput = z.infer<typeof updateStudentProfileSchema>;

export const studentIdParamSchema = z.object({ id: z.string().uuid() });

export type StudentIdParam = z.infer<typeof studentIdParamSchema>;

export const studentResponseSchema = z
  .object({
    id: z.string(),
    accountId: z.string(),
    name: z.string(),
    areaId: z.number(),
    address: z.string(),
    emergencyContact: z.string(),
    phoneNumber: z.string(),
    whatsappNumber: z.string().nullable(),
    studentIdNumber: z.string(),
    whatsappVerifiedAt: z.string().nullable().optional(),
    verificationStatus: z.nativeEnum(VerificationStatus),
    ratingAvg: z.number(),
    ratingCount: z.number(),
    location: ownLocationResponseSchema,
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({ id: "StudentProfile" });

// What other people see of a student: no contact details, no address.
export const studentPublicProfileSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    area: z.object({ id: z.number(), name: z.string() }),
    ratingAvg: z.number(),
    ratingCount: z.number(),
  })
  .meta({ id: "StudentPublicProfile" });

export const studentReviewSchema = z
  .object({
    id: z.string(),
    rating: z.number(),
    comment: z.string().nullable(),
    createdAt: z.string(),
    tutor: z.object({ id: z.string(), name: z.string() }),
  })
  .meta({ id: "StudentReview" });

export const studentReviewListSchema = z
  .object({ reviews: z.array(studentReviewSchema) })
  .meta({ id: "StudentReviewList" });
