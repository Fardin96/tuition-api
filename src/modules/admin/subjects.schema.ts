import { z } from "zod";

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const subjectNameSchema = z.string().trim().min(2).max(60);
const subjectSlugSchema = z.string().min(2).max(60).regex(SLUG_PATTERN);
const sortOrderSchema = z.number().int().min(0).max(1000);

export const subjectIdParamSchema = z.object({ id: z.coerce.number().int().positive() });
export type SubjectIdParam = z.infer<typeof subjectIdParamSchema>;

export const adminSubjectSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    slug: z.string(),
    sortOrder: z.number().int(),
    isActive: z.boolean(),
    tutorCount: z.number().int(),
  })
  .meta({ id: "AdminSubject" });
export type AdminSubject = z.infer<typeof adminSubjectSchema>;

export const adminSubjectListSchema = z
  .object({ subjects: z.array(adminSubjectSchema) })
  .meta({ id: "AdminSubjectList" });

export const createSubjectSchema = z
  .object({
    name: subjectNameSchema,
    slug: subjectSlugSchema.optional(),
    sortOrder: sortOrderSchema.default(0),
  })
  .strict()
  .meta({ id: "CreateSubject" });
export type CreateSubjectInput = z.infer<typeof createSubjectSchema>;

export const updateSubjectSchema = z
  .object({
    name: subjectNameSchema.optional(),
    slug: subjectSlugSchema.optional(),
    sortOrder: sortOrderSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: "Send at least one field to change",
  })
  .meta({ id: "UpdateSubject" });
export type UpdateSubjectInput = z.infer<typeof updateSubjectSchema>;
