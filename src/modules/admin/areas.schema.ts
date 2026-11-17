import { z } from "zod";
import { DISTRICTS, DIVISIONS } from "../../lib/districts.js";

const districtCodeSchema = z.enum(Object.keys(DISTRICTS) as [string, ...string[]]);
const areaNameSchema = z.string().trim().min(2).max(60);

export const areaIdParamSchema = z.object({ id: z.coerce.number().int().positive() });
export type AreaIdParam = z.infer<typeof areaIdParamSchema>;

export const adminAreaSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    division: z.string(),
    district: z.string(),
    districtCode: z.string().nullable(),
    isActive: z.boolean(),
    tutorCount: z.number().int(),
    studentCount: z.number().int(),
    requirementCount: z.number().int(),
  })
  .meta({ id: "AdminArea" });
export type AdminArea = z.infer<typeof adminAreaSchema>;

export const adminAreaDistrictSchema = z
  .object({
    code: z.string(),
    name: z.string(),
    division: z.enum(DIVISIONS),
  })
  .meta({ id: "AdminAreaDistrict" });
export type AdminAreaDistrict = z.infer<typeof adminAreaDistrictSchema>;

export const adminAreaListSchema = z
  .object({
    areas: z.array(adminAreaSchema),
    districts: z.array(adminAreaDistrictSchema),
  })
  .meta({ id: "AdminAreaList" });
export type AdminAreaList = z.infer<typeof adminAreaListSchema>;

export const adminAreaListQuerySchema = z.object({
  districtCode: districtCodeSchema.optional(),
  q: z.string().trim().min(1).max(60).optional(),
  // true or false, as a query string. Same convention as the fees overdue filter.
  isActive: z.enum(["true", "false"]).optional(),
});
export type AdminAreaListQuery = z.infer<typeof adminAreaListQuerySchema>;

export const createAreaSchema = z
  .object({
    districtCode: districtCodeSchema,
    name: areaNameSchema,
  })
  .strict()
  .meta({ id: "CreateArea" });
export type CreateAreaInput = z.infer<typeof createAreaSchema>;

// Division and district are not editable: moving an area would break the rule that a tutor's
// areas sit in their city.
export const updateAreaSchema = z
  .object({
    name: areaNameSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: "Send at least one field to change",
  })
  .meta({ id: "UpdateArea" });
export type UpdateAreaInput = z.infer<typeof updateAreaSchema>;
