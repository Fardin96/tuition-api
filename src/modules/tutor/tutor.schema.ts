import { z } from "zod";
import { Gender } from "../../generated/prisma/enums.js";

export const tutorProfileSchema = z.object({
  name: z.string().min(1).max(200),
  address: z.string().min(1).max(500),
  emergencyContact: z.string().min(1).max(50),
  whatsappNumber: z.string().min(1).max(20),
  studentIdNumber: z.string().min(1).max(100),
  gender: z.nativeEnum(Gender),
  parentsInfo: z.string().max(1000).optional(),
});

export type TutorProfileInput = z.infer<typeof tutorProfileSchema>;

export const updateTutorProfileSchema = tutorProfileSchema.partial();

export type UpdateTutorProfileInput = z.infer<typeof updateTutorProfileSchema>;

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
  whatsappNumber: z.string(),
  studentIdNumber: z.string(),
  gender: z.string(),
  parentsInfo: z.string().nullable().optional(),
  whatsappVerifiedAt: z.string().nullable().optional(),
  verificationStatus: z.string(),
  isListed: z.boolean(),
  ratingAvg: z.number(),
  ratingCount: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
