import { z } from "zod";

export const studentProfileSchema = z.object({
  name: z.string().min(1).max(200),
  areaId: z.coerce.number().int().positive(),
  address: z.string().min(1).max(500),
  emergencyContact: z.string().min(1).max(50),
  whatsappNumber: z.string().min(1).max(20),
  studentIdNumber: z.string().min(1).max(100),
  placeId: z.string().min(1).max(255).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  districtCode: z.string().min(1).max(100).optional(),
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
  whatsappNumber: z.string(),
  studentIdNumber: z.string(),
  whatsappVerifiedAt: z.string().nullable().optional(),
  verificationStatus: z.string(),
  ratingAvg: z.number(),
  ratingCount: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
