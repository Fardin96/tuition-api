import { z } from "zod";
import { Gender } from "../../generated/prisma/enums.js";
import { locationSchema, ownLocationResponseSchema } from "../location/location.schema.js";

export const tutorProfileSchema = z.object({
  name: z.string().min(1).max(200),
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
  gender: z.nativeEnum(Gender),
  parentsInfo: z.string().max(1000).optional(),
  location: locationSchema.optional(),
});

export type TutorProfileInput = z.infer<typeof tutorProfileSchema>;

export const updateTutorProfileSchema = tutorProfileSchema.partial();

export type UpdateTutorProfileInput = z.infer<typeof updateTutorProfileSchema>;

export const tutorNearbyQuerySchema = z.object({
  radiusMeters: z.coerce.number().int().min(100).max(50000).default(5000),
});

export const tutorAreasSchema = z.object({
  areaIds: z.array(z.coerce.number().int().positive()).max(50),
});

export type TutorAreasInput = z.infer<typeof tutorAreasSchema>;

export const tutorSubjectsSchema = z.object({
  subjectIds: z.array(z.coerce.number().int().positive()).max(50),
});

export type TutorSubjectsInput = z.infer<typeof tutorSubjectsSchema>;

export const tutorIdParamSchema = z.object({ id: z.string().uuid() });

export type TutorIdParam = z.infer<typeof tutorIdParamSchema>;

export const tutorSearchQuerySchema = z.object({
  area: z.coerce.number().int().positive().optional(),
  subject: z.coerce.number().int().positive().optional(),
  gender: z.nativeEnum(Gender).optional(),
  rating: z.coerce.number().min(0).max(5).optional(),
  name: z.string().optional(),
});

export type TutorSearchQuery = z.infer<typeof tutorSearchQuerySchema>;

export const tutorResponseSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  name: z.string(),
  address: z.string(),
  emergencyContact: z.string(),
  phoneNumber: z.string(),
  whatsappNumber: z.string(),
  studentIdNumber: z.string(),
  gender: z.string(),
  parentsInfo: z.string().nullable().optional(),
  whatsappVerifiedAt: z.string().nullable().optional(),
  verificationStatus: z.string(),
  isListed: z.boolean(),
  ratingAvg: z.number(),
  ratingCount: z.number(),
  needsReaddress: z.boolean().optional(),
  location: ownLocationResponseSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type TutorNearbyQuery = z.infer<typeof tutorNearbyQuerySchema>;
