import { z } from "zod";
import { locationSchema, ownLocationResponseSchema } from "../location/location.schema.js";

export const studentProfileSchema = z.object({
  name: z.string().min(1).max(200),
  areaId: z.coerce.number().int().positive(),
  address: z.string().min(1).max(500),
  emergencyContact: z.string().min(1).max(50),
  phoneNumber: z
    .string()
    .min(1)
    .max(20)
    .refine((v) => !v.startsWith("deleted:"), "Invalid number")
    .optional(),
  whatsappNumber: z
    .string()
    .min(1)
    .max(20)
    .refine((v) => !v.startsWith("deleted:"), "Invalid number"),
  studentIdNumber: z.string().min(1).max(100),
  location: locationSchema.optional(),
});

export type StudentProfileInput = z.infer<typeof studentProfileSchema>;

export const updateStudentProfileSchema = studentProfileSchema.partial();

export type UpdateStudentProfileInput = z.infer<typeof updateStudentProfileSchema>;

export const studentIdParamSchema = z.object({ id: z.string().uuid() });

export type StudentIdParam = z.infer<typeof studentIdParamSchema>;

export const studentResponseSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  name: z.string(),
  areaId: z.number(),
  address: z.string(),
  emergencyContact: z.string(),
  phoneNumber: z.string(),
  whatsappNumber: z.string(),
  studentIdNumber: z.string(),
  whatsappVerifiedAt: z.string().nullable().optional(),
  verificationStatus: z.string(),
  ratingAvg: z.number(),
  ratingCount: z.number(),
  location: ownLocationResponseSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
