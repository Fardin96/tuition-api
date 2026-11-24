import { z } from "zod";
import { InstitutionKind } from "../../generated/prisma/enums.js";

// A pick from the search. Null unlinks the row; absent leaves the link as it is.
export const institutionIdSchema = z.number().int().positive().nullable().optional();

export const institutionSearchQuerySchema = z.object({
  q: z.string().trim().min(2).max(60),
  for: z.enum(["tutor", "student"]).optional(),
  limit: z.coerce.number().int().min(1).max(20).default(8),
});
export type InstitutionSearchQuery = z.infer<typeof institutionSearchQuerySchema>;

export const institutionOptionSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    kind: z.nativeEnum(InstitutionKind),
    district: z.string().nullable(),
    area: z.string().nullable(),
    matchedAlias: z.string().nullable(),
  })
  .meta({ id: "InstitutionOption" });

export const institutionListSchema = z
  .object({ institutions: z.array(institutionOptionSchema) })
  .meta({ id: "InstitutionList" });
