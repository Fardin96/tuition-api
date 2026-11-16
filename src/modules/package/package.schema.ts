import { z } from "zod";
import {
  ApplicationStatus,
  Gender,
  ListingStatus,
  ModerationStatus,
} from "../../generated/prisma/enums.js";
import { ACADEMIC_GROUPS, ADMISSION_TARGETS, CURRICULA } from "../../lib/education.js";

export const packageIdParamSchema = z.object({ id: z.string().uuid() });
export type PackageIdParam = z.infer<typeof packageIdParamSchema>;

export const browseScopeSchema = z.enum(["nearby", "all"]);

export const packageBrowseQuerySchema = z.object({
  scope: browseScopeSchema.default("nearby"),
  curriculum: z.enum(CURRICULA).optional(),
  levelCode: z.coerce.number().int().min(-4).max(13).optional(),
  subjectId: z.coerce.number().int().positive().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});
export type PackageBrowseQuery = z.infer<typeof packageBrowseQuerySchema>;

export const myApplicationSchema = z
  .object({ id: z.string(), status: z.nativeEnum(ApplicationStatus) })
  .meta({ id: "MyApplication" });

export const packageSchema = z
  .object({
    id: z.string(),
    tutor: z.object({
      id: z.string(),
      name: z.string(),
      gender: z.nativeEnum(Gender),
      ratingAvg: z.number(),
      ratingCount: z.number(),
    }),
    subjectId: z.number(),
    /** null = online */
    areaId: z.number().nullable(),
    curriculum: z.enum(CURRICULA),
    levelCode: z.number(),
    academicGroup: z.enum(ACADEMIC_GROUPS).nullable(),
    admissionTargets: z.array(z.enum(ADMISSION_TARGETS)),
    isRetaker: z.boolean(),
    levelNote: z.string().nullable(),
    /** "HH:MM" */
    timeOfDay: z.string(),
    daysPerWeek: z.number(),
    expectedSalary: z.number(),
    studentCount: z.number(),
    /** YYYY-MM-DD */
    availableFrom: z.string(),
    status: z.nativeEnum(ListingStatus),
    moderationStatus: z.nativeEnum(ModerationStatus),
    createdAt: z.date(),
    /** Already has a CONFIRMED or COMPLETED application: no new requests. */
    closed: z.boolean(),
    /** The calling student's application on this package, if any. Always null for tutors and admins. */
    myApplication: myApplicationSchema.nullable(),
  })
  .meta({ id: "Package" });
export type PackageResponse = z.infer<typeof packageSchema>;

export const packagePageSchema = z
  .object({
    packages: z.array(packageSchema),
    nextCursor: z.string().nullable(),
    /** The student has no usable pin, so `nearby` fell back to online packages plus their profile area. */
    locationMissing: z.boolean(),
  })
  .meta({ id: "PackagePage" });
export type PackagePageResponse = z.infer<typeof packagePageSchema>;
