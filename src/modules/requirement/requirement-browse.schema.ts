import { z } from "zod";
import { ACADEMIC_GROUPS, ADMISSION_TARGETS, CURRICULA } from "../../lib/education.js";
import { myApplicationSchema } from "../package/package.schema.js";
import { tutorGenderPrefSchema } from "./requirement.schema.js";

// Requirement-only: packages keep the shared browseScopeSchema (nearby | all).
export const requirementBrowseScopeSchema = z.enum(["nearby", "all", "set"]);

export const requirementBrowseQuerySchema = z
  .object({
    scope: requirementBrowseScopeSchema.default("nearby"),
    // The tutor's own active requirement set. Only read when scope=set.
    setId: z.string().uuid().optional(),
    curriculum: z.enum(CURRICULA).optional(),
    levelCode: z.coerce.number().int().min(-4).max(13).optional(),
    subjectId: z.coerce.number().int().positive().optional(),
    areaId: z.coerce.number().int().positive().optional(),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
  })
  .refine((q) => q.scope !== "set" || q.setId !== undefined, {
    message: "setId is required when scope is set",
    path: ["setId"],
  });
export type RequirementBrowseQuery = z.infer<typeof requirementBrowseQuerySchema>;

// What a tutor sees of an OPEN requirement: no student name, contact or coordinates.
export const browseRequirementSchema = z
  .object({
    id: z.string(),
    areaId: z.number().nullable(),
    subjectIds: z.array(z.number()),
    curriculum: z.enum(CURRICULA).nullable(),
    levelCode: z.number().nullable(),
    academicGroup: z.enum(ACADEMIC_GROUPS).nullable(),
    admissionTargets: z.array(z.enum(ADMISSION_TARGETS)),
    isRetaker: z.boolean(),
    levelNote: z.string().nullable(),
    /** "HH:MM" */
    timeOfDay: z.string().nullable(),
    daysPerWeek: z.number().nullable(),
    availableDays: z.number(),
    salary: z.number().nullable(),
    studentCount: z.number().nullable(),
    /** YYYY-MM-DD */
    hireByDate: z.string().nullable(),
    tutorGenderPref: tutorGenderPrefSchema,
    tuitionType: z.string().nullable(),
    createdAt: z.date(),
    /** Tutor pin to student pin, rounded to 0.5 km. null when either pin is missing. */
    distanceKm: z.number().nullable(),
    /** Already has a CONFIRMED or COMPLETED application: shown as "Application closed". */
    closed: z.boolean(),
    myApplication: myApplicationSchema.nullable(),
  })
  .meta({ id: "BrowseRequirement" });
export type BrowseRequirementResponse = z.infer<typeof browseRequirementSchema>;

export const browseRequirementPageSchema = z
  .object({
    requirements: z.array(browseRequirementSchema),
    nextCursor: z.string().nullable(),
    /** The tutor has no zones and no areas, so `nearby` can match nothing. */
    noServiceArea: z.boolean(),
  })
  .meta({ id: "BrowseRequirementPage" });
export type BrowseRequirementPageResponse = z.infer<typeof browseRequirementPageSchema>;
