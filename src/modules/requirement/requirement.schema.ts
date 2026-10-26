import { z } from "zod";

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

export const CLASS_LEVELS: Record<number, string> = {
  1: "Class 1",
  2: "Class 2",
  3: "Class 3",
  4: "Class 4",
  5: "Class 5",
  6: "Class 6",
  7: "Class 7",
  8: "Class 8",
  9: "Class 9",
  10: "Class 10",
  11: "HSC 1st year",
  12: "HSC 2nd year",
  13: "Admission prep",
  14: "University year 1",
  15: "University year 2",
  16: "University year 3",
  17: "University year 4",
};
export const classLevelSchema = z.coerce.number().int().min(1).max(17);

// HH:MM -> stored as a time; we convert to a Date during persistence.
export const timeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/);

// Base schema without defaults
const baseRequirementSchema = z.object({
  categoryId: z.coerce.number().int().positive(),
  areaId: z.coerce.number().int().positive(),
  subjectIds: z.array(z.coerce.number().int().positive()).min(1),
  classLevel: classLevelSchema,
  timeOfDay: timeOfDaySchema,
  daysPerWeek: z.coerce.number().int().min(1).max(7),
  salary: z.coerce.number().int().positive(),
  studentCount: z.coerce.number().int().min(1),
  hireByDate: z.string().date(),
  tutorGenderPref: tutorGenderPrefSchema,
  instituteName: z.string().max(200).optional(),
  tuitionType: tuitionTypeSchema,
});

const openRequirementSchema = baseRequirementSchema.extend({
  studentCount: z.coerce.number().int().min(1).default(1),
  tutorGenderPref: tutorGenderPrefSchema.default("ANY"),
  status: z.literal("OPEN").default("OPEN"),
});

const draftRequirementSchema = baseRequirementSchema.partial().extend({
  studentCount: z.coerce.number().int().min(1).default(1),
  tutorGenderPref: tutorGenderPrefSchema.default("ANY"),
  status: z.literal("DRAFT"),
});

export const createRequirementSchema = z.union([openRequirementSchema, draftRequirementSchema]);

export type CreateRequirementInput = z.infer<typeof createRequirementSchema>;

export const updateRequirementSchema = baseRequirementSchema.partial().extend({
  status: z.enum(["DRAFT", "OPEN"]).optional(),
});
export type UpdateRequirementInput = z.infer<typeof updateRequirementSchema>;

export const requirementResponseSchema = z.object({
  id: z.string(),
  studentId: z.string(),
  categoryId: z.number().nullable(),
  areaId: z.number().nullable(),
  subjectIds: z.array(z.number()),
  classLevel: z.number().nullable(),
  timeOfDay: z.string().nullable(),
  daysPerWeek: z.number().nullable(),
  salary: z.number().nullable(),
  studentCount: z.number().nullable(),
  hireByDate: z.string().nullable(),
  tutorGenderPref: z.string(),
  instituteName: z.string().nullable(),
  tuitionType: z.string().nullable(),
  status: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const requirementListResponseSchema = z.object({
  requirements: z.array(requirementResponseSchema),
});
