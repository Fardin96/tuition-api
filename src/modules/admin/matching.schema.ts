import { z } from "zod";
import { DISTRICT_CODES } from "../../lib/districts.js";
import { CURRICULA } from "../../lib/education.js";
import {
  matchingConfigInputSchema,
  matchingRulesSchema,
  RULE_IDS,
  RULE_MODES,
} from "../matching/matching-config.js";

const ruleIdSchema = z.enum(RULE_IDS);
const ruleModeSchema = z.enum(RULE_MODES);
// "reach" is the city / online limit; the others are the REQUIRED rules.
const blockerSchema = z.enum(["reach", ...RULE_IDS]);
const curriculumSchema = z.enum(CURRICULA);

// Request body of PUT /admin/matching/config. The rules and their checks live in matching-config.ts.
export const matchingConfigBodySchema = matchingConfigInputSchema.meta({ id: "MatchingConfig" });
export type MatchingConfigBody = z.infer<typeof matchingConfigBodySchema>;

export const matchingConfigValueSchema = z
  .object({
    version: z.number().int(),
    rules: matchingRulesSchema,
    cityEdgeKm: z.number(),
    outsideCityKm: z.number(),
    distanceScoreKm: z.number().int(),
    admissionIgnoresCurriculum: z.boolean(),
    curriculumEquivalents: z.array(z.array(curriculumSchema)),
  })
  .meta({ id: "MatchingConfigValue" });

export const matchingConfigRecordSchema = z
  .object({
    config: matchingConfigValueSchema,
    defaults: matchingConfigValueSchema,
    ruleModes: z.record(ruleIdSchema, z.array(ruleModeSchema)),
    updatedAt: z.date().nullable(),
    updatedByName: z.string().nullable(),
  })
  .meta({ id: "MatchingConfigRecord" });
export type MatchingConfigRecord = z.infer<typeof matchingConfigRecordSchema>;

export const matchingPreviewSchema = z
  .object({
    version: z.number().int(),
    openRequirements: z.number().int(),
    requirementsWithNoTutor: z.number().int(),
    requirementsWithFewTutors: z.number().int(),
    requirementsWithManyTutors: z.number().int(),
    listedTutors: z.number().int(),
    tutorsWithAMatch: z.number().int(),
    /** Requirements with no tutor that one blocker alone keeps empty. */
    blockers: z.array(z.object({ rule: blockerSchema, requirements: z.number().int() })),
  })
  .meta({ id: "MatchingPreview" });

export const matchingPreviewRequestSchema = z
  .object({ config: matchingConfigBodySchema })
  .strict()
  .meta({ id: "MatchingPreviewRequest" });
export type MatchingPreviewRequest = z.infer<typeof matchingPreviewRequestSchema>;

export const matchingPreviewPairSchema = z
  .object({
    /** The saved config. */
    current: matchingPreviewSchema,
    /** The posted config, under the same version as current. */
    draft: matchingPreviewSchema,
  })
  .meta({ id: "MatchingPreviewPair" });

export const ruleResultSchema = z
  .object({ mode: ruleModeSchema, pass: z.boolean(), part: z.number() })
  .meta({ id: "RuleResult" });

export const matchPartsSchema = z
  .object({
    version: z.number().int(),
    score: z.number().int(),
    passes: z.boolean(),
    reach: z.boolean(),
    rules: z.record(ruleIdSchema, ruleResultSchema),
  })
  .meta({ id: "MatchParts" });

export const explainSetSchema = z
  .object({
    setId: z.string(),
    name: z.string(),
    isDefault: z.boolean(),
    studentCity: z.string().nullable(),
    inZone: z.boolean(),
    distanceKm: z.number().nullable(),
    isOnline: z.boolean(),
    sharedSubjects: z.number().int(),
    totalSubjects: z.number().int(),
    parts: matchPartsSchema,
  })
  .meta({ id: "ExplainSet" });

export const matchingExplainQuerySchema = z.object({
  requirementId: z.string().uuid(),
  tutorId: z.string().uuid(),
});
export type MatchingExplainQuery = z.infer<typeof matchingExplainQuerySchema>;

export const matchingExplainSchema = z
  .object({
    version: z.number().int(),
    requirement: z.object({
      id: z.string(),
      curriculum: curriculumSchema.nullable(),
      levelCode: z.number().int().nullable(),
      tuitionType: z.string().nullable(),
      status: z.string(),
    }),
    tutor: z.object({ id: z.string(), name: z.string(), isListed: z.boolean() }),
    sets: z.array(explainSetSchema),
  })
  .meta({ id: "MatchingExplain" });

export const matchingUnmatchedQuerySchema = z.object({
  olderThanHours: z.coerce.number().int().min(0).max(720).default(24),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type MatchingUnmatchedQuery = z.infer<typeof matchingUnmatchedQuerySchema>;

export const matchingUnmatchedSchema = z
  .object({
    requirements: z.array(
      z.object({
        id: z.string(),
        createdAt: z.date(),
        studentName: z.string(),
        curriculum: curriculumSchema.nullable(),
        levelCode: z.number().int().nullable(),
        subjectIds: z.array(z.number().int()),
        areaId: z.number().int().nullable(),
        tuitionType: z.string().nullable(),
        blockers: z.array(blockerSchema),
      }),
    ),
  })
  .meta({ id: "MatchingUnmatched" });

export const citySlugParamSchema = z.object({
  slug: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/),
});
export type CitySlugParam = z.infer<typeof citySlugParamSchema>;

export const adminCitySchema = z
  .object({
    slug: z.string(),
    name: z.string(),
    districtCode: z.string(),
    isActive: z.boolean(),
    areaKm2: z.number(),
    updatedAt: z.date(),
  })
  .meta({ id: "AdminCity" });
export type AdminCity = z.infer<typeof adminCitySchema>;

export const adminCityListSchema = z.object({ cities: z.array(adminCitySchema) }).meta({
  id: "AdminCityList",
});

const districtCodeSchema = z.enum([...DISTRICT_CODES] as [string, ...string[]]);

// GeoJSON geometry. The ring shapes are checked by PostGIS (ST_GeomFromGeoJSON) in the service.
export const cityBoundarySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("Polygon"), coordinates: z.array(z.any()) }),
  z.object({ type: z.literal("MultiPolygon"), coordinates: z.array(z.any()) }),
]);

export const upsertCitySchema = z
  .object({
    name: z.string().trim().min(2).max(60),
    districtCode: districtCodeSchema,
    boundary: cityBoundarySchema,
    isActive: z.boolean().optional(),
  })
  .strict()
  .meta({ id: "CityUpsert" });
export type UpsertCityInput = z.infer<typeof upsertCitySchema>;

export const updateCitySchema = z
  .object({ isActive: z.boolean() })
  .strict()
  .meta({ id: "CityUpdate" });
export type UpdateCityInput = z.infer<typeof updateCitySchema>;
