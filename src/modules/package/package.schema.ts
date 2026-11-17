import { z } from "zod";
import {
  ApplicationStatus,
  Gender,
  ListingStatus,
  ModerationStatus,
  PackageCoverage,
} from "../../generated/prisma/enums.js";
import { DAYS_PER_WEEK_MESSAGE, daysPerWeekFits } from "../../lib/days.js";
import {
  ACADEMIC_GROUPS,
  ADMISSION_TARGETS,
  CURRICULA,
  LEVEL_MAX,
  LEVEL_MIN,
  validateTutorCoverage,
} from "../../lib/education.js";

export const packageIdParamSchema = z.object({ id: z.string().uuid() });
export type PackageIdParam = z.infer<typeof packageIdParamSchema>;

export const browseScopeSchema = z.enum(["nearby", "all"]);

// A package matches a filter when it covers it: curriculum in curricula, level inside the range,
// subject among its subjects.
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
    title: z.string(),
    /** What the package covers. */
    description: z.string(),
    coverage: z.nativeEnum(PackageCoverage),
    durationWeeks: z.number(),
    /** BDT for the whole package. */
    price: z.number(),
    subjectIds: z.array(z.number()),
    levelMin: z.number(),
    levelMax: z.number(),
    curricula: z.array(z.enum(CURRICULA)),
    /** Empty = any group. */
    academicGroups: z.array(z.enum(ACADEMIC_GROUPS)),
    /** Empty = any target. */
    admissionTargets: z.array(z.enum(ADMISSION_TARGETS)),
    /** "HH:MM" */
    timeFrom: z.string(),
    /** "HH:MM" */
    timeTo: z.string(),
    /** Weekday bitmask, bit0 = Saturday. */
    availableDays: z.number(),
    /** null = any number of the available days. */
    daysPerWeek: z.number().nullable(),
    maxStudents: z.number(),
    /** YYYY-MM-DD */
    availableFrom: z.string(),
    teachesOnline: z.boolean(),
    /** How many teaching zones the package uses. The zones themselves stay private to the tutor. */
    zoneCount: z.number(),
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
    /** The student has no usable pin, so `nearby` fell back to online packages only. */
    locationMissing: z.boolean(),
  })
  .meta({ id: "PackagePage" });
export type PackagePageResponse = z.infer<typeof packagePageSchema>;

// ───────── tutor writes (#51, #53, #55, #56) ─────────

const hhmm = /^([01]\d|2[0-3]):([0-5]\d)$/;
const availableDaysSchema = z.number().int().min(1).max(127);
const maxStudentsSchema = z.number().int().min(1).max(50);
const uniqueIds = <T>(v: T[]) => new Set(v).size === v.length;

export const PACKAGE_PRICE_MAX = 5_000_000;
export const PACKAGE_DURATION_MAX_WEEKS = 104;
export const ZONE_OR_ONLINE_MESSAGE = "Pick at least one zone or teach online";

// Same fields and limits as a tutor set (CreateTutorRequirement), plus the offer.
const packageFieldsSchema = z.object({
  title: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(600),
  coverage: z.nativeEnum(PackageCoverage),
  durationWeeks: z.number().int().min(1).max(PACKAGE_DURATION_MAX_WEEKS),
  /** BDT for the whole package. The placement fee is a percentage of it. */
  price: z.number().int().positive().max(PACKAGE_PRICE_MAX),
  subjectIds: z.array(z.number().int().positive()).min(1).refine(uniqueIds),
  levelMin: z.number().int().min(LEVEL_MIN).max(LEVEL_MAX),
  levelMax: z.number().int().min(LEVEL_MIN).max(LEVEL_MAX),
  curricula: z.array(z.enum(CURRICULA)).min(1),
  academicGroups: z.array(z.enum(ACADEMIC_GROUPS)),
  admissionTargets: z.array(z.enum(ADMISSION_TARGETS)),
  /** "HH:MM" */
  timeFrom: z.string().regex(hhmm),
  /** "HH:MM", after timeFrom */
  timeTo: z.string().regex(hhmm),
  availableDays: availableDaysSchema,
  /** null = any number of the available days */
  daysPerWeek: z.number().int().min(1).max(7).nullable(),
  maxStudents: maxStudentsSchema,
  /** YYYY-MM-DD */
  availableFrom: z.string().date(),
  teachesOnline: z.boolean(),
  /** The tutor's own zones. Empty is allowed only with teachesOnline. */
  zoneIds: z.array(z.string().uuid()).refine(uniqueIds),
  // Adds subjects missing from the tutor's profile in the same transaction, as sets do.
  syncProfileSubjects: z.boolean().optional(),
});

export type PackageRules = Pick<
  z.infer<typeof packageFieldsSchema>,
  | "levelMin"
  | "levelMax"
  | "curricula"
  | "academicGroups"
  | "admissionTargets"
  | "timeFrom"
  | "timeTo"
  | "availableDays"
  | "daysPerWeek"
  | "teachesOnline"
  | "zoneIds"
>;

/** Cross-field rules, shared by create (in zod) and update (on the merged row, in the service). */
export function packageRuleIssues(v: PackageRules): { path: string; message: string }[] {
  const issues = validateTutorCoverage(v).map((i) => ({ path: i.path, message: i.message }));
  if (v.timeTo <= v.timeFrom) {
    issues.push({ path: "timeTo", message: "timeTo must be after timeFrom" });
  }
  if (!daysPerWeekFits(v.daysPerWeek, v.availableDays)) {
    issues.push({ path: "daysPerWeek", message: DAYS_PER_WEEK_MESSAGE });
  }
  if (!v.teachesOnline && v.zoneIds.length === 0) {
    issues.push({ path: "zoneIds", message: ZONE_OR_ONLINE_MESSAGE });
  }
  return issues;
}

export const createPackageSchema = packageFieldsSchema
  .extend({
    academicGroups: packageFieldsSchema.shape.academicGroups.default([]),
    admissionTargets: packageFieldsSchema.shape.admissionTargets.default([]),
    availableDays: availableDaysSchema.default(127),
    daysPerWeek: packageFieldsSchema.shape.daysPerWeek.default(null),
    maxStudents: maxStudentsSchema.default(1),
    teachesOnline: z.boolean().default(false),
    zoneIds: packageFieldsSchema.shape.zoneIds.default([]),
  })
  .strict()
  .superRefine((v, ctx) => {
    for (const issue of packageRuleIssues(v)) {
      ctx.addIssue({ code: "custom", path: [issue.path], message: issue.message });
    }
  })
  .meta({ id: "CreatePackage" });
export type CreatePackageInput = z.infer<typeof createPackageSchema>;

// No cross-field refine here: the service checks packageRuleIssues on the merged values.
export const updatePackageSchema = packageFieldsSchema
  .partial()
  .strict()
  .refine((v) => Object.keys(v).some((key) => key !== "syncProfileSubjects"), {
    message: "Send at least one field",
  })
  .meta({ id: "UpdatePackage" });
export type UpdatePackageInput = z.infer<typeof updatePackageSchema>;

export const myPackageSchema = packageSchema
  .extend({
    zoneIds: z.array(z.string()),
    moderationNote: z.string().nullable(),
    updatedAt: z.date(),
    /** Student requests still waiting for the tutor. */
    pendingRequestCount: z.number(),
    /** All student requests on this package, in any status. */
    requestCount: z.number(),
  })
  .meta({ id: "MyPackage" });
export type MyPackageResponse = z.infer<typeof myPackageSchema>;

export const myPackageListSchema = z
  .object({ packages: z.array(myPackageSchema) })
  .meta({ id: "MyPackageList" });
export type MyPackageListResponse = z.infer<typeof myPackageListSchema>;
