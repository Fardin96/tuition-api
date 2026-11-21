import { z } from "zod";
import { ACADEMIC_GROUPS, ADMISSION_TARGETS, CURRICULA } from "../../lib/education.js";
import { myApplicationSchema } from "../package/package.schema.js";
import { tutorGenderPrefSchema } from "./requirement.schema.js";
import { matchReasonSchema } from "./requirement-match.schema.js";

// Requirement-only: packages keep the shared browseScopeSchema (nearby | all).
// set: the tutor's own set, through the matching engine. invited: requirements the tutor was invited to.
export const requirementBrowseScopeSchema = z.enum(["nearby", "all", "set", "invited"]);
export const requirementBrowseSortSchema = z.enum(["newest", "match"]);

export const requirementBrowseQuerySchema = z
  .object({
    scope: requirementBrowseScopeSchema.default("nearby"),
    // newest (default) or match (best score first). match needs scope=set.
    sort: requirementBrowseSortSchema.default("newest"),
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
  })
  .refine((q) => q.sort !== "match" || q.scope === "set", {
    message: "sort=match needs scope=set",
    path: ["sort"],
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
    /** When the student invited this tutor to the requirement, else null. */
    invitedAt: z.date().nullable(),
    /** scope=set only: the set's score and reasons for this requirement. Null otherwise. */
    match: z.object({ score: z.number().int(), reasons: z.array(matchReasonSchema) }).nullable(),
  })
  .meta({ id: "BrowseRequirement" });
export type BrowseRequirementResponse = z.infer<typeof browseRequirementSchema>;

export const browseRequirementPageSchema = z
  .object({
    requirements: z.array(browseRequirementSchema),
    nextCursor: z.string().nullable(),
    /** The tutor has no zones and no areas, so `nearby` can match nothing. */
    noServiceArea: z.boolean(),
    /** scope=set: the matching config version the scores were computed under. Null otherwise. */
    matchVersion: z.number().int().nullable(),
    /**
     * scope=set, first page, when nothing matches: what one change to the set would show more
     * open requirements. Empty otherwise.
     */
    gaps: z.array(
      z.object({
        code: z.enum(["WIDER_LEVEL", "OTHER_SUBJECTS", "TEACH_ONLINE"]),
        requirements: z.number().int(),
      }),
    ),
  })
  .meta({ id: "BrowseRequirementPage" });
export type BrowseRequirementPageResponse = z.infer<typeof browseRequirementPageSchema>;
