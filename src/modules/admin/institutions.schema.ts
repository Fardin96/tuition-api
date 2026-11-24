import { z } from "zod";
import { InstitutionKind } from "../../generated/prisma/enums.js";

// A name made only of punctuation would match every search, so it needs a letter or digit.
const nameSchema = z
  .string()
  .trim()
  .min(2)
  .max(150)
  .refine((s) => /[a-z0-9]/i.test(s), "Name needs letters or numbers");
const kindSchema = z.nativeEnum(InstitutionKind);
const placeSchema = z.string().trim().min(1).max(60);
const aliasSchema = z.string().trim().min(2).max(60);
const aliasesSchema = z.array(aliasSchema).max(20);

export const institutionIdParamSchema = z.object({ id: z.coerce.number().int().positive() });
export type InstitutionIdParam = z.infer<typeof institutionIdParamSchema>;

export const institutionListQuerySchema = z.object({
  q: z.string().trim().min(1).max(60).optional(),
  kind: kindSchema.optional(),
  status: z.enum(["active", "inactive", "all"]).default("all"),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type InstitutionListQuery = z.infer<typeof institutionListQuerySchema>;

export const adminInstitutionSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    kind: kindSchema,
    district: z.string().nullable(),
    area: z.string().nullable(),
    eiin: z.string().nullable(),
    aliases: z.array(z.string()),
    isActive: z.boolean(),
    popularity: z.number().int(),
    tutorCount: z.number().int(),
    requirementCount: z.number().int(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({ id: "AdminInstitution" });
export type AdminInstitution = z.infer<typeof adminInstitutionSchema>;

export const adminInstitutionListSchema = z
  .object({ institutions: z.array(adminInstitutionSchema), total: z.number().int() })
  .meta({ id: "AdminInstitutionList" });

export const createInstitutionSchema = z
  .object({
    name: nameSchema,
    kind: kindSchema,
    district: placeSchema.nullable().optional(),
    area: placeSchema.nullable().optional(),
    aliases: aliasesSchema.optional(),
  })
  .strict()
  .meta({ id: "CreateInstitution" });
export type CreateInstitutionInput = z.infer<typeof createInstitutionSchema>;

export const updateInstitutionSchema = z
  .object({
    name: nameSchema.optional(),
    kind: kindSchema.optional(),
    district: placeSchema.nullable().optional(),
    area: placeSchema.nullable().optional(),
    aliases: aliasesSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: "Send at least one field to change",
  })
  .meta({ id: "UpdateInstitution" });
export type UpdateInstitutionInput = z.infer<typeof updateInstitutionSchema>;
