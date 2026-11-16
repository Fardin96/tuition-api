import { z } from "zod";
import {
  ApplicationStatus,
  FeeStatus,
  Gender,
  InitiatedBy,
  ListingStatus,
} from "../../generated/prisma/enums.js";
import { ACADEMIC_GROUPS, CURRICULA } from "../../lib/education.js";

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
    ratingAvg: z.number(),
    ratingCount: z.number(),
  })
  .meta({ id: "ApplicationTutor" });

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
