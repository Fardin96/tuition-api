import { z } from "zod";
import {
  ApplicationStatus,
  FeeStatus,
  Gender,
  InitiatedBy,
  ListingStatus,
  VerificationStatus,
} from "../../generated/prisma/enums.js";
import { ACADEMIC_GROUPS, ADMISSION_TARGETS, CURRICULA } from "../../lib/education.js";

export const APPLICATION_ACTIONS = [
  "confirm",
  "reject",
  "withdraw",
  "reopen",
  "cancel",
  "complete",
] as const;
export type ApplicationAction = (typeof APPLICATION_ACTIONS)[number];

// A placement fee left unpaid this many days after confirmation is shown as Unpaid.
// Payment stays possible; reminders stop (src/cron/fee-reminders.ts).
export const FEE_UNPAID_AFTER_DAYS = 21;
export const FEE_DUE_IN_DAYS = 7;

export const applicationIdParamSchema = z.object({ id: z.string().uuid() });
export type ApplicationIdParam = z.infer<typeof applicationIdParamSchema>;

export const applicationListQuerySchema = z.object({
  status: z.nativeEnum(ApplicationStatus).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type ApplicationListQuery = z.infer<typeof applicationListQuerySchema>;

export const applicationTutorSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    gender: z.nativeEnum(Gender),
    instituteName: z.string().nullable(),
    ratingAvg: z.number(),
    ratingCount: z.number(),
  })
  .meta({ id: "ApplicationTutor" });

// The tutor's details for the student (and admins) on an application.
// No phone, address, student ID or files.
export const applicationTutorProfileSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    gender: z.nativeEnum(Gender),
    instituteName: z.string().nullable(),
    ratingAvg: z.number(),
    ratingCount: z.number(),
    verificationStatus: z.nativeEnum(VerificationStatus),
    areas: z.array(z.object({ id: z.number(), name: z.string() })),
    subjects: z.array(z.object({ id: z.number(), name: z.string() })),
    credentials: z.array(z.object({ id: z.string(), examLabel: z.string(), result: z.string() })),
  })
  .meta({ id: "ApplicationTutorProfile" });
export type ApplicationTutorProfile = z.infer<typeof applicationTutorProfileSchema>;

// The tutor set behind an application. MATCH: a set that covers the requirement. DEFAULT: no set
// covers it, so the tutor's default set is shown. PACKAGE: the package's own set.
export const applicationTutorSetSchema = z
  .object({
    matchedBy: z.enum(["MATCH", "DEFAULT", "PACKAGE"]),
    set: z.object({
      id: z.string(),
      name: z.string(),
      isDefault: z.boolean(),
      levelMin: z.number(),
      levelMax: z.number(),
      curricula: z.array(z.enum(CURRICULA)),
      academicGroups: z.array(z.enum(ACADEMIC_GROUPS)),
      admissionTargets: z.array(z.enum(ADMISSION_TARGETS)),
      subjectIds: z.array(z.number()),
      /** "HH:MM" */
      timeFrom: z.string(),
      /** "HH:MM" */
      timeTo: z.string(),
      availableDays: z.number(),
      daysPerWeek: z.number().nullable(),
      minSalary: z.number().nullable(),
      maxStudents: z.number(),
      teachesOnline: z.boolean(),
    }),
  })
  .meta({ id: "ApplicationTutorSet" });
export type ApplicationTutorSet = z.infer<typeof applicationTutorSetSchema>;

export const applicationStudentSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    areaId: z.number(),
  })
  .meta({ id: "ApplicationStudent" });

/** The listing the application points at. `closed` = it already has a CONFIRMED or COMPLETED application. */
export const applicationTargetSchema = z
  .object({
    kind: z.enum(["REQUIREMENT", "PACKAGE"]),
    id: z.string(),
    status: z.nativeEnum(ListingStatus),
    closed: z.boolean(),
    areaId: z.number().nullable(),
    subjectIds: z.array(z.number()),
    curriculum: z.enum(CURRICULA).nullable(),
    levelCode: z.number().nullable(),
    academicGroup: z.enum(ACADEMIC_GROUPS).nullable(),
    /** BDT per month: requirement salary or package expected salary. */
    salary: z.number().nullable(),
    daysPerWeek: z.number().nullable(),
    /** "HH:MM" */
    timeOfDay: z.string().nullable(),
  })
  .meta({ id: "ApplicationTarget" });

export const applicationSchema = z
  .object({
    id: z.string(),
    initiatedBy: z.nativeEnum(InitiatedBy),
    status: z.nativeEnum(ApplicationStatus),
    appliedAt: z.date(),
    confirmedAt: z.date().nullable(),
    endedAt: z.date().nullable(),
    tutor: applicationTutorSchema,
    student: applicationStudentSchema,
    target: applicationTargetSchema,
    /** Actions the caller may take now. Empty for admins. */
    allowedActions: z.array(z.enum(APPLICATION_ACTIONS)),
  })
  .meta({ id: "Application" });
export type ApplicationResponse = z.infer<typeof applicationSchema>;

export const applicationContactSchema = z
  .object({
    phoneNumber: z.string(),
    whatsappNumber: z.string().nullable(),
  })
  .meta({ id: "ApplicationContact" });

export const applicationFeeSchema = z
  .object({
    id: z.string(),
    amountDue: z.string(),
    amountPaid: z.string(),
    status: z.nativeEnum(FeeStatus),
    /** YYYY-MM-DD */
    dueDate: z.string(),
    /** DUE or PARTIAL more than FEE_UNPAID_AFTER_DAYS after confirmation. Payment is still accepted. */
    unpaid: z.boolean(),
  })
  .meta({ id: "ApplicationFee" });

export const applicationDetailSchema = applicationSchema
  .extend({
    /** The other party's numbers. Only on CONFIRMED and COMPLETED; null otherwise. */
    counterpartContact: applicationContactSchema.nullable(),
    /** The placement fee. Only the tutor (and admins) see it; null for students or when none exists. */
    fee: applicationFeeSchema.nullable(),
    /** The tutor's details. Only the student (and admins); null for the tutor. */
    tutorProfile: applicationTutorProfileSchema.nullable(),
    /** The tutor's set for this application. Only the student (and admins). Null for the tutor,
     *  or when the tutor has no set. */
    tutorSet: applicationTutorSetSchema.nullable(),
  })
  .meta({ id: "ApplicationDetail" });
export type ApplicationDetailResponse = z.infer<typeof applicationDetailSchema>;

export const applicationPageSchema = z
  .object({
    applications: z.array(applicationSchema),
    nextCursor: z.string().nullable(),
  })
  .meta({ id: "ApplicationPage" });
export type ApplicationPageResponse = z.infer<typeof applicationPageSchema>;
