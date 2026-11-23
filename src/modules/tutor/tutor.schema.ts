import { z } from "zod";
import {
  FileStatus,
  Gender,
  ModerationStatus,
  VerificationStatus,
} from "../../generated/prisma/enums.js";
import { DAYS_PER_WEEK_MESSAGE, daysPerWeekFits } from "../../lib/days.js";
import {
  ACADEMIC_GROUPS,
  ADMISSION_TARGETS,
  CURRICULA,
  LEVEL_MAX,
  LEVEL_MIN,
  validateTutorCoverage,
} from "../../lib/education.js";
import { fileIdSchema } from "../files/files.schema.js";
import { locationSchema, ownLocationResponseSchema } from "../location/location.schema.js";
import { reviewSummarySchema } from "../review/review.schema.js";

const instituteNameSchema = z.string().trim().min(1).max(120);

export const tutorProfileSchema = z
  .object({
    name: z.string().min(1).max(200),
    instituteName: instituteNameSchema.optional(),
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
  })
  .meta({ id: "CreateTutorProfile" });

export type TutorProfileInput = z.infer<typeof tutorProfileSchema>;

export const updateTutorProfileSchema = tutorProfileSchema
  .partial()
  .meta({ id: "UpdateTutorProfile" });

export type UpdateTutorProfileInput = z.infer<typeof updateTutorProfileSchema>;

export const tutorNearbyQuerySchema = z.object({
  radiusMeters: z.coerce.number().int().min(100).max(50000).default(5000),
});

export const tutorAreasSchema = z
  .object({
    areaIds: z.array(z.coerce.number().int().positive()).max(50),
  })
  .meta({ id: "ReplaceTutorAreas" });

export type TutorAreasInput = z.infer<typeof tutorAreasSchema>;

export const MAX_PROFILE_SUBJECTS = 50;

export const tutorSubjectsSchema = z
  .object({
    subjectIds: z.array(z.coerce.number().int().positive()).max(MAX_PROFILE_SUBJECTS),
  })
  .meta({ id: "ReplaceTutorSubjects" });

export type TutorSubjectsInput = z.infer<typeof tutorSubjectsSchema>;

export const tutorIdParamSchema = z.object({ id: z.string().uuid() });

export type TutorIdParam = z.infer<typeof tutorIdParamSchema>;

export const tutorSearchQuerySchema = z.object({
  // Ids are INT4 columns; a larger value would fail in Postgres instead of matching nothing.
  area: z.coerce.number().int().positive().max(2147483647).optional(),
  subject: z.coerce.number().int().positive().max(2147483647).optional(),
  gender: z.nativeEnum(Gender).optional(),
  rating: z.coerce.number().min(0).max(5).optional(),
  name: z.string().optional(),
  // District name (Area.district, e.g. "Dhaka"), matched case-insensitively.
  district: z.string().trim().min(1).max(80).optional(),
  // "true": only tutors who joined in the last RECENT_TUTOR_DAYS days.
  recent: z.enum(["true", "false"]).optional(),
  // Omitted: every matching row, no paging. With limit: one page of at most 50 rows.
  limit: z.coerce.number().int().min(1).max(50).optional(),
  // Keyset cursor from a previous nextCursor. Ignored without limit.
  cursor: z.string().max(200).optional(),
});

export type TutorSearchQuery = z.infer<typeof tutorSearchQuerySchema>;

export const tutorResponseSchema = z
  .object({
    id: z.string(),
    accountId: z.string(),
    name: z.string(),
    instituteName: z.string().nullable(),
    address: z.string(),
    emergencyContact: z.string().nullable(),
    phoneNumber: z.string(),
    whatsappNumber: z.string().nullable(),
    studentIdNumber: z.string().nullable(),
    gender: z.nativeEnum(Gender),
    parentsInfo: z.string().nullable().optional(),
    whatsappVerifiedAt: z.string().nullable().optional(),
    verificationStatus: z.nativeEnum(VerificationStatus),
    isListed: z.boolean(),
    ratingAvg: z.number(),
    ratingCount: z.number(),
    needsReaddress: z.boolean().optional(),
    location: ownLocationResponseSchema,
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({ id: "Tutor" });

export const tutorAreasResponseSchema = z
  .object({
    areas: z.array(z.object({ area: z.object({ id: z.number(), name: z.string() }) })),
  })
  .meta({ id: "TutorAreas" });

export const tutorSubjectsResponseSchema = z
  .object({
    subjects: z.array(z.object({ subject: z.object({ id: z.number(), name: z.string() }) })),
  })
  .meta({ id: "TutorSubjects" });

export const tutorVerificationResponseSchema = z
  .object({
    id: z.string(),
    status: z.nativeEnum(VerificationStatus),
    submittedAt: z.string(),
    decidedAt: z.string().nullable(),
    note: z.string().nullable(),
    file: z.object({ id: z.string(), status: z.nativeEnum(FileStatus) }),
  })
  .meta({ id: "TutorVerification" });

export const tutorVerificationListResponseSchema = z
  .object({
    verifications: z.array(tutorVerificationResponseSchema),
  })
  .meta({ id: "TutorVerificationList" });

export const tutorNearbyResultSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    instituteName: z.string().nullable(),
    gender: z.nativeEnum(Gender),
    ratingAvg: z.number(),
    ratingCount: z.number(),
    distanceMeters: z.number(),
    avatarUrl: z.string().nullable(),
    areas: z.array(z.object({ id: z.number(), name: z.string() })),
    subjects: z.array(z.object({ id: z.number(), name: z.string() })),
  })
  .meta({ id: "TutorNearbyResult" });

export const tutorNearbyListResponseSchema = z
  .object({
    tutors: z.array(tutorNearbyResultSchema),
  })
  .meta({ id: "TutorNearbyList" });

export const tutorSearchResultSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    instituteName: z.string().nullable(),
    gender: z.nativeEnum(Gender),
    avatarUrl: z.string().nullable(),
    ratingAvg: z.number(),
    ratingCount: z.number(),
    areas: z.array(z.object({ id: z.number(), name: z.string() })),
    subjects: z.array(z.object({ id: z.number(), name: z.string() })),
  })
  .meta({ id: "TutorSearchResult" });

export const tutorSearchListResponseSchema = z
  .object({
    tutors: z.array(tutorSearchResultSchema),
    nextCursor: z.string().nullable(),
  })
  .meta({ id: "TutorSearchList" });

export const tutorCredentialResponseSchema = z
  .object({
    id: z.string(),
    examLabel: z.string(),
    result: z.string(),
    file: z.object({ id: z.string(), status: z.nativeEnum(FileStatus) }),
  })
  .meta({ id: "TutorCredential" });

export const createCredentialSchema = z
  .object({
    examLabel: z.string().trim().min(1).max(80),
    result: z.string().trim().min(1).max(40),
    fileId: fileIdSchema,
  })
  .meta({ id: "CreateCredential" });

export type CreateCredentialInput = z.infer<typeof createCredentialSchema>;

export const tutorCredentialListResponseSchema = z
  .object({
    credentials: z.array(tutorCredentialResponseSchema),
  })
  .meta({ id: "TutorCredentialList" });

export const createVideoSchema = z
  .object({
    title: z.string().trim().min(1).max(100),
    fileId: fileIdSchema,
  })
  .meta({ id: "CreateVideo" });

export type CreateVideoInput = z.infer<typeof createVideoSchema>;

export const tutorVideoResponseSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    status: z.nativeEnum(ModerationStatus),
    moderationNote: z.string().nullable(),
    /** True while the tutor agrees to show this video on the home page (once approved). */
    showOnHomePage: z.boolean(),
    sortOrder: z.number(),
    createdAt: z.string(),
    url: z.string().nullable(),
    file: z.object({ id: z.string(), status: z.nativeEnum(FileStatus) }),
  })
  .meta({ id: "TutorVideo" });

export const setVideoHomePageSchema = z
  .object({ showOnHomePage: z.boolean() })
  .strict()
  .meta({ id: "SetVideoHomePage" });
export type SetVideoHomePageInput = z.infer<typeof setVideoHomePageSchema>;

export const tutorVideoListResponseSchema = z
  .object({
    videos: z.array(tutorVideoResponseSchema),
  })
  .meta({ id: "TutorVideoList" });

export const tutorPublicVideoResponseSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    sortOrder: z.number(),
    createdAt: z.string(),
    url: z.string().nullable(),
    tutor: z.object({ id: z.string(), name: z.string() }),
    file: z.object({ id: z.string(), status: z.nativeEnum(FileStatus) }),
  })
  .meta({ id: "TutorPublicVideo" });

export const tutorPublicVideoListResponseSchema = z
  .object({
    videos: z.array(tutorPublicVideoResponseSchema),
  })
  .meta({ id: "TutorPublicVideoList" });

// The profile's videos are the approved ones only; the route converts createdAt to a string.
export const tutorPublicProfileSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    instituteName: z.string().nullable(),
    gender: z.nativeEnum(Gender),
    avatarUrl: z.string().nullable(),
    ratingAvg: z.number(),
    ratingCount: z.number(),
    verificationStatus: z.nativeEnum(VerificationStatus),
    isListed: z.boolean(),
    needsReaddress: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
    areas: z.array(z.object({ id: z.number(), name: z.string() })),
    subjects: z.array(z.object({ id: z.number(), name: z.string() })),
    credentials: z.array(tutorCredentialResponseSchema),
    videos: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        sortOrder: z.number(),
        createdAt: z.string(),
        url: z.string().nullable(),
        file: z.object({ id: z.string(), status: z.nativeEnum(FileStatus) }),
      }),
    ),
  })
  .meta({ id: "TutorPublicProfile" });

export const tutorPublicProfileResponseSchema = z
  .object({
    tutor: tutorPublicProfileSchema,
  })
  .meta({ id: "TutorPublicProfileResult" });

export const tutorReviewResponseSchema = z
  .object({
    id: z.string(),
    rating: z.number(),
    comment: z.string().nullable(),
    createdAt: z.string(),
    student: z.object({ id: z.string(), name: z.string(), avatarUrl: z.string().nullable() }),
  })
  .meta({ id: "TutorReview" });

export const tutorReviewListResponseSchema = z
  .object({
    reviews: z.array(tutorReviewResponseSchema),
    nextCursor: z.string().nullable(),
    summary: reviewSummarySchema,
  })
  .meta({ id: "TutorReviewList" });

export type TutorNearbyQuery = z.infer<typeof tutorNearbyQuerySchema>;

export const tutorRequirementIdParamSchema = z.object({ id: z.string().uuid() });

export type TutorRequirementIdParam = z.infer<typeof tutorRequirementIdParamSchema>;

const hhmm = /^([01]\d|2[0-3]):([0-5]\d)$/;
const isoDate = /^\d{4}-\d{2}-\d{2}$/;

const availableDaysSchema = z.number().int().min(1).max(127);
// null = no fixed count: any number of the available days.
const daysPerWeekSchema = z.number().int().min(1).max(7).nullable();
const maxStudentsSchema = z.number().int().min(1);
const zoneIdsSchema = z.array(z.string().uuid()).refine((v) => new Set(v).size === v.length);

const tutorRequirementBaseSchema = z.object({
  name: z.string().trim().min(1).max(60),
  levelMin: z.number().int().min(LEVEL_MIN).max(LEVEL_MAX),
  levelMax: z.number().int().min(LEVEL_MIN).max(LEVEL_MAX),
  curricula: z.array(z.enum(CURRICULA)).min(1),
  academicGroups: z.array(z.enum(ACADEMIC_GROUPS)),
  admissionTargets: z.array(z.enum(ADMISSION_TARGETS)),
  timeFrom: z.string().regex(hhmm),
  timeTo: z.string().regex(hhmm),
  availableDays: availableDaysSchema,
  daysPerWeek: daysPerWeekSchema.optional(),
  minSalary: z.number().int().positive().nullable().optional(),
  maxStudents: maxStudentsSchema,
  availableFrom: z.string().regex(isoDate),
  teachesOnline: z.boolean(),
  subjectIds: z
    .array(z.number().int().positive())
    .min(1)
    .refine((v) => new Set(v).size === v.length),
  zoneIds: zoneIdsSchema,
  // Adds the requirement's subjects to the tutor's profile in the same transaction when they are missing.
  syncProfileSubjects: z.boolean().optional(),
});

export const createTutorRequirementSchema = tutorRequirementBaseSchema
  .extend({
    availableDays: availableDaysSchema.default(127),
    maxStudents: maxStudentsSchema.default(1),
    teachesOnline: z.boolean().default(false),
    zoneIds: zoneIdsSchema.default([]),
    academicGroups: z.array(z.enum(ACADEMIC_GROUPS)).default([]),
    admissionTargets: z.array(z.enum(ADMISSION_TARGETS)).default([]),
  })
  .strict()
  .refine((v) => v.timeTo > v.timeFrom, "timeTo must be after timeFrom")
  .superRefine((v, ctx) => {
    for (const issue of validateTutorCoverage(v)) {
      ctx.addIssue({ code: "custom", path: [issue.path], message: issue.message });
    }
    if (!daysPerWeekFits(v.daysPerWeek, v.availableDays)) {
      ctx.addIssue({ code: "custom", path: ["daysPerWeek"], message: DAYS_PER_WEEK_MESSAGE });
    }
    if (!v.teachesOnline && v.zoneIds.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["zoneIds"],
        message: "Pick a zone or turn on online teaching",
      });
    }
  })
  .meta({ id: "CreateTutorRequirement" });

export type CreateTutorRequirementInput = z.infer<typeof createTutorRequirementSchema>;

export const updateTutorRequirementSchema = tutorRequirementBaseSchema
  .partial()
  .strict()
  .refine(
    (v) => Object.keys(v).some((key) => key !== "syncProfileSubjects"),
    "At least one field is required",
  )
  .meta({ id: "UpdateTutorRequirement" });

export type UpdateTutorRequirementInput = z.infer<typeof updateTutorRequirementSchema>;

export const tutorRequirementResponseSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    isDefault: z.boolean(),
    isActive: z.boolean(),
    levelMin: z.number(),
    levelMax: z.number(),
    curricula: z.array(z.enum(CURRICULA)),
    academicGroups: z.array(z.enum(ACADEMIC_GROUPS)),
    admissionTargets: z.array(z.enum(ADMISSION_TARGETS)),
    timeFrom: z.string(),
    timeTo: z.string(),
    availableDays: z.number(),
    daysPerWeek: z.number().nullable(),
    minSalary: z.number().nullable(),
    maxStudents: z.number(),
    availableFrom: z.string(),
    teachesOnline: z.boolean(),
    subjectIds: z.array(z.number()),
    zoneIds: z.array(z.string()),
  })
  .meta({ id: "TutorRequirement" });

export type TutorRequirementResponse = z.infer<typeof tutorRequirementResponseSchema>;

export const tutorRequirementListQuerySchema = z.object({
  status: z.enum(["active", "archived", "all"]).default("active"),
});

export type TutorRequirementListQuery = z.infer<typeof tutorRequirementListQuerySchema>;

export const tutorRequirementListResponseSchema = z
  .object({
    requirements: z.array(tutorRequirementResponseSchema),
  })
  .meta({ id: "TutorRequirementList" });
