import { z } from "zod";
import { ListingStatus } from "../../generated/prisma/enums.js";
import {
  ACADEMIC_GROUPS,
  ADMISSION_TARGETS,
  CURRICULA,
  LEVEL_MAX,
  LEVEL_MIN,
  LEVEL_NOTE_MAX,
  normalizeLevelNote,
  validateStudentEducation,
} from "../../lib/education.js";

export const requirementIdParamSchema = z.object({ id: z.string().uuid() });
export type RequirementIdParam = z.infer<typeof requirementIdParamSchema>;

export const tutorGenderPrefSchema = z.enum(["ANY", "MALE", "FEMALE"]);

export const TUITION_TYPES = [
  "Home Tutoring Solo",
  "Home Tutoring Group",
  "Online",
  "Group Coaching",
] as const;
export type TuitionType = (typeof TUITION_TYPES)[number];
export const tuitionTypeSchema = z.enum(TUITION_TYPES);

// HH:MM -> stored as a time; we convert to a Date during persistence.
export const timeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/);

// Drafts and edits may clear every subject; OPEN creation requires at least one.
const subjectIdsSchema = z.array(z.coerce.number().int().positive());

// Not coerced: "" or null must fail, not turn into level 0 (a valid level).
const levelCodeSchema = z.number().int().min(LEVEL_MIN).max(LEVEL_MAX);

// Normalized first; the result must still fit the stored limit.
const levelNoteSchema = z
  .string()
  .nullable()
  .transform(normalizeLevelNote)
  .pipe(z.string().max(LEVEL_NOTE_MAX).nullable());

// Base schema without defaults
const baseRequirementSchema = z.object({
  areaId: z.coerce.number().int().positive(),
  subjectIds: subjectIdsSchema,
  curriculum: z.enum(CURRICULA),
  levelCode: levelCodeSchema,
  academicGroup: z.enum(ACADEMIC_GROUPS).nullable(),
  admissionTargets: z.array(z.enum(ADMISSION_TARGETS)),
  isRetaker: z.boolean(),
  levelNote: levelNoteSchema,
  timeOfDay: timeOfDaySchema,
  daysPerWeek: z.coerce.number().int().min(1).max(7),
  salary: z.coerce.number().int().positive(),
  studentCount: z.coerce.number().int().min(1),
  hireByDate: z.string().date(),
  tutorGenderPref: tutorGenderPrefSchema,
  instituteName: z.string().max(200).optional(),
  tuitionType: tuitionTypeSchema,
});

// Runs the shared education rules on create. Missing optional fields count as empty.
function checkEducation(
  data: {
    curriculum?: (typeof CURRICULA)[number];
    levelCode?: number;
    academicGroup?: (typeof ACADEMIC_GROUPS)[number] | null;
    admissionTargets?: (typeof ADMISSION_TARGETS)[number][];
    isRetaker?: boolean;
    levelNote?: string | null;
  },
  ctx: z.RefinementCtx,
) {
  const issues = validateStudentEducation({
    curriculum: data.curriculum ?? null,
    levelCode: data.levelCode ?? null,
    academicGroup: data.academicGroup ?? null,
    admissionTargets: data.admissionTargets ?? [],
    isRetaker: data.isRetaker ?? false,
    levelNote: data.levelNote ?? null,
  });
  for (const issue of issues) {
    ctx.addIssue({ code: "custom", path: [issue.path], message: issue.message });
  }
}

const openRequirementSchema = baseRequirementSchema
  .extend({
    subjectIds: subjectIdsSchema.min(1),
    academicGroup: z.enum(ACADEMIC_GROUPS).nullable().optional(),
    admissionTargets: z.array(z.enum(ADMISSION_TARGETS)).optional(),
    isRetaker: z.boolean().optional(),
    levelNote: levelNoteSchema.optional(),
    studentCount: z.coerce.number().int().min(1).default(1),
    tutorGenderPref: tutorGenderPrefSchema.default("ANY"),
    status: z.literal("OPEN").default("OPEN"),
  })
  .superRefine(checkEducation);

const draftRequirementSchema = baseRequirementSchema
  .partial()
  .extend({
    studentCount: z.coerce.number().int().min(1).default(1),
    tutorGenderPref: tutorGenderPrefSchema.default("ANY"),
    status: z.literal("DRAFT"),
  })
  .superRefine(checkEducation);

export const createRequirementSchema = z
  .union([openRequirementSchema, draftRequirementSchema])
  .meta({ id: "CreateRequirement" });

export type CreateRequirementInput = z.infer<typeof createRequirementSchema>;

// No superRefine here: the service validates the merged values against the stored row.
export const updateRequirementSchema = baseRequirementSchema
  .partial()
  .extend({
    status: z.enum(["DRAFT", "OPEN"]).optional(),
  })
  .meta({ id: "UpdateRequirement" });
export type UpdateRequirementInput = z.infer<typeof updateRequirementSchema>;

export const requirementResponseSchema = z
  .object({
    id: z.string(),
    studentId: z.string(),
    areaId: z.number().nullable(),
    subjectIds: z.array(z.number()),
    curriculum: z.enum(CURRICULA).nullable(),
    levelCode: z.number().nullable(),
    academicGroup: z.enum(ACADEMIC_GROUPS).nullable(),
    admissionTargets: z.array(z.enum(ADMISSION_TARGETS)),
    isRetaker: z.boolean(),
    levelNote: z.string().nullable(),
    timeOfDay: z.string().nullable(),
    daysPerWeek: z.number().nullable(),
    salary: z.number().nullable(),
    studentCount: z.number().nullable(),
    hireByDate: z.string().nullable(),
    tutorGenderPref: tutorGenderPrefSchema,
    instituteName: z.string().nullable(),
    tuitionType: tuitionTypeSchema.nullable(),
    status: z.enum(ListingStatus),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({ id: "Requirement" });

export const requirementListResponseSchema = z
  .object({
    requirements: z.array(requirementResponseSchema),
  })
  .meta({ id: "RequirementList" });
