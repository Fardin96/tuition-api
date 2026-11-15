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
    .refine((v) => !v.startsWith("deleted:"), "Invalid number"),
  whatsappNumber: z
    .string()
    .min(1)
    .max(20)
    .refine((v) => !v.startsWith("deleted:"), "Invalid number")
    .nullable()
    .optional(),
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
  whatsappNumber: z.string().nullable(),
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

export const tutorRequirementIdParamSchema = z.object({ id: z.string().uuid() });

export type TutorRequirementIdParam = z.infer<typeof tutorRequirementIdParamSchema>;

const hhmm = /^([01]\d|2[0-3]):([0-5]\d)$/;
const isoDate = /^\d{4}-\d{2}-\d{2}$/;

const availableDaysSchema = z.number().int().min(1).max(127);
const maxStudentsSchema = z.number().int().min(1);
const zoneIdsSchema = z.array(z.string().uuid()).refine((v) => new Set(v).size === v.length);

const tutorRequirementBaseSchema = z.object({
  name: z.string().trim().min(1).max(60),
  classLevelMin: z.number().int().min(1).max(20),
  classLevelMax: z.number().int().min(1).max(20),
  timeFrom: z.string().regex(hhmm),
  timeTo: z.string().regex(hhmm),
  availableDays: availableDaysSchema,
  minSalary: z.number().int().positive().nullable().optional(),
  maxStudents: maxStudentsSchema,
  availableFrom: z.string().regex(isoDate),
  teachesOnline: z.boolean(),
  subjectIds: z
    .array(z.number().int().positive())
    .min(1)
    .refine((v) => new Set(v).size === v.length),
  zoneIds: zoneIdsSchema,
});

export const createTutorRequirementSchema = tutorRequirementBaseSchema
  .extend({
    availableDays: availableDaysSchema.default(127),
    maxStudents: maxStudentsSchema.default(1),
    teachesOnline: z.boolean().default(false),
    zoneIds: zoneIdsSchema.default([]),
  })
  .strict()
  .refine((v) => v.classLevelMax >= v.classLevelMin, "classLevelMax must be >= classLevelMin")
  .refine((v) => v.timeTo > v.timeFrom, "timeTo must be after timeFrom");

export type CreateTutorRequirementInput = z.infer<typeof createTutorRequirementSchema>;

export const updateTutorRequirementSchema = tutorRequirementBaseSchema
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "At least one field is required");

export type UpdateTutorRequirementInput = z.infer<typeof updateTutorRequirementSchema>;

export const tutorRequirementResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  isDefault: z.boolean(),
  isActive: z.boolean(),
  classLevelMin: z.number(),
  classLevelMax: z.number(),
  timeFrom: z.string(),
  timeTo: z.string(),
  availableDays: z.number(),
  minSalary: z.number().nullable(),
  maxStudents: z.number(),
  availableFrom: z.string(),
  teachesOnline: z.boolean(),
  subjectIds: z.array(z.number()),
  zoneIds: z.array(z.string()),
  mappedPackageCount: z.number(),
});

export type TutorRequirementResponse = z.infer<typeof tutorRequirementResponseSchema>;

export const tutorRequirementListQuerySchema = z.object({
  status: z.enum(["active", "archived", "all"]).default("active"),
});

export type TutorRequirementListQuery = z.infer<typeof tutorRequirementListQuerySchema>;

export const tutorRequirementListResponseSchema = z.object({
  requirements: z.array(tutorRequirementResponseSchema),
});
