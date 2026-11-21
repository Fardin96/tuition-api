import { z } from "zod";
import { writeAudit } from "../../lib/admin.js";
import { CURRICULA } from "../../lib/education.js";
import { prisma } from "../../lib/prisma.js";

// The admin's global matching rules, stored as one JSON object in platform_setting (key matching_config).
// A missing or unreadable row means DEFAULT_MATCHING_CONFIG. Every save bumps `version`, which match
// responses and application.match_version carry.

export const MATCHING_CONFIG_KEY = "matching_config";

// REQUIRED hides a pair that fails the rule. RANK only changes the score. OFF ignores the rule.
export const RULE_MODES = ["REQUIRED", "RANK", "OFF"] as const;
export type RuleMode = (typeof RULE_MODES)[number];

// Every rule, in the order the admin page and explain responses list them.
export const RULE_IDS = [
  "curriculum",
  "level",
  "subject",
  "groupTarget",
  "location",
  "gender",
  "salary",
  "schedule",
  "capacity",
  "quality",
  "recency",
] as const;
export type RuleId = (typeof RULE_IDS)[number];

// Which modes each rule accepts. Curriculum, level and subject can never be OFF; quality and recency
// only rank. Location REQUIRED means the student pin is inside one of the set's zones; the city limit
// for home tuition applies in every mode.
export const RULE_ALLOWED_MODES: Record<RuleId, readonly RuleMode[]> = {
  curriculum: ["REQUIRED", "RANK"],
  level: ["REQUIRED", "RANK"],
  subject: ["REQUIRED", "RANK"],
  groupTarget: RULE_MODES,
  location: ["REQUIRED", "RANK"],
  gender: RULE_MODES,
  salary: RULE_MODES,
  schedule: RULE_MODES,
  capacity: RULE_MODES,
  quality: ["RANK", "OFF"],
  recency: ["RANK", "OFF"],
};

const ruleSchema = z.object({
  mode: z.enum(RULE_MODES),
  weight: z.number().int().min(0).max(10),
});

const curriculumEnum = z.enum(CURRICULA);

export const matchingRulesSchema = z.object({
  curriculum: ruleSchema,
  level: ruleSchema.extend({ slack: z.number().int().min(0).max(2) }),
  subject: ruleSchema.extend({ requireAll: z.boolean() }),
  groupTarget: ruleSchema,
  location: ruleSchema,
  gender: ruleSchema,
  salary: ruleSchema,
  schedule: ruleSchema,
  capacity: ruleSchema,
  quality: ruleSchema,
  recency: ruleSchema,
});

// The editable part. `version` is set by the server.
export const matchingConfigInputSchema = z
  .object({
    rules: matchingRulesSchema,
    /** A tutor living outside the student's city still matches within this many km of its edge. */
    cityEdgeKm: z.number().min(0).max(2).multipleOf(0.5),
    /** Student outside every city: tutor in the same district, home or zone centre within this many km. */
    outsideCityKm: z.number().min(0.5).max(3).multipleOf(0.5),
    /** Location score falls from 1 to 0 over this distance when the student is outside the set's zones. */
    distanceScoreKm: z.number().int().min(1).max(20),
    /** Level 13 (admission prep) matches on admission targets and skips the curriculum rule. */
    admissionIgnoresCurriculum: z.boolean(),
    /** Groups of curricula treated as one, e.g. Bangla Medium with English Version. */
    curriculumEquivalents: z.array(z.array(curriculumEnum).min(2).max(CURRICULA.length)).max(4),
  })
  .superRefine((cfg, ctx) => {
    for (const id of RULE_IDS) {
      if (!RULE_ALLOWED_MODES[id].includes(cfg.rules[id].mode)) {
        ctx.addIssue({
          code: "custom",
          path: ["rules", id, "mode"],
          message: `${id} cannot be ${cfg.rules[id].mode}`,
        });
      }
    }
    const seen = new Set<string>();
    cfg.curriculumEquivalents.forEach((group, i) => {
      if (new Set(group).size !== group.length) {
        ctx.addIssue({
          code: "custom",
          path: ["curriculumEquivalents", i],
          message: "A group lists a curriculum twice",
        });
      }
      for (const c of group) {
        if (seen.has(c)) {
          ctx.addIssue({
            code: "custom",
            path: ["curriculumEquivalents", i],
            message: `${c} is in more than one group`,
          });
        }
        seen.add(c);
      }
    });
    const ranked = RULE_IDS.filter((id) => cfg.rules[id].mode !== "OFF");
    if (ranked.every((id) => cfg.rules[id].weight === 0)) {
      ctx.addIssue({
        code: "custom",
        path: ["rules"],
        message: "At least one rule that is not off needs a weight above 0",
      });
    }
  });
export type MatchingConfigInput = z.infer<typeof matchingConfigInputSchema>;
export type MatchingConfig = MatchingConfigInput & { version: number };

export const DEFAULT_MATCHING_CONFIG: MatchingConfig = {
  version: 0,
  rules: {
    curriculum: { mode: "REQUIRED", weight: 3 },
    level: { mode: "REQUIRED", weight: 3, slack: 0 },
    subject: { mode: "REQUIRED", weight: 3, requireAll: false },
    groupTarget: { mode: "REQUIRED", weight: 1 },
    location: { mode: "RANK", weight: 3 },
    gender: { mode: "REQUIRED", weight: 1 },
    salary: { mode: "RANK", weight: 2 },
    schedule: { mode: "RANK", weight: 2 },
    capacity: { mode: "RANK", weight: 1 },
    quality: { mode: "RANK", weight: 2 },
    recency: { mode: "RANK", weight: 1 },
  },
  cityEdgeKm: 2,
  outsideCityKm: 2,
  distanceScoreKm: 10,
  admissionIgnoresCurriculum: true,
  curriculumEquivalents: [],
};

// A stored value that no longer parses (an older shape) falls back to the defaults, keeping its version
// so the next save still moves forward.
export function parseStoredConfig(raw: unknown): MatchingConfig {
  const version =
    raw && typeof raw === "object" && Number.isInteger((raw as { version?: unknown }).version)
      ? Number((raw as { version: number }).version)
      : 0;
  const parsed = matchingConfigInputSchema.safeParse(raw);
  return parsed.success ? { ...parsed.data, version } : { ...DEFAULT_MATCHING_CONFIG, version };
}

// Per-process cache. Other instances pick up a save within CACHE_MS.
const CACHE_MS = 30_000;
let cached: { config: MatchingConfig; at: number } | null = null;

export function resetMatchingConfigCache() {
  cached = null;
}

export async function getMatchingConfig(): Promise<MatchingConfig> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.config;
  const row = await prisma.platformSetting.findUnique({
    where: { key: MATCHING_CONFIG_KEY },
    select: { value: true },
  });
  const config = row ? parseStoredConfig(row.value) : DEFAULT_MATCHING_CONFIG;
  cached = { config, at: Date.now() };
  return config;
}

export async function getMatchingConfigRecord() {
  const row = await prisma.platformSetting.findUnique({
    where: { key: MATCHING_CONFIG_KEY },
    select: { value: true, updatedAt: true, updatedBy: { select: { name: true } } },
  });
  return {
    config: row ? parseStoredConfig(row.value) : DEFAULT_MATCHING_CONFIG,
    defaults: DEFAULT_MATCHING_CONFIG,
    updatedAt: row?.updatedAt ?? null,
    updatedByName: row?.updatedBy?.name ?? null,
  };
}

// One transaction with its audit row. The advisory lock serialises saves, including the first one when
// no row exists yet to lock, so two saves cannot reuse a version.
export async function saveMatchingConfig(
  input: MatchingConfigInput,
  admin: { accountId: string },
  ip: string | undefined,
) {
  const saved = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${MATCHING_CONFIG_KEY}))`;
    const rows = await tx.$queryRaw<{ value: unknown }[]>`
      SELECT value FROM platform_setting WHERE key = ${MATCHING_CONFIG_KEY} FOR UPDATE
    `;
    const previous = rows[0] ? parseStoredConfig(rows[0].value) : DEFAULT_MATCHING_CONFIG;
    const next: MatchingConfig = { ...input, version: previous.version + 1 };
    await tx.platformSetting.upsert({
      where: { key: MATCHING_CONFIG_KEY },
      create: { key: MATCHING_CONFIG_KEY, value: next, updatedById: admin.accountId },
      update: { value: next, updatedById: admin.accountId },
    });
    await writeAudit(tx, {
      actorAccountId: admin.accountId,
      action: "matching.update",
      entityType: "platform_setting",
      entityId: MATCHING_CONFIG_KEY,
      before: previous,
      after: next,
      ip: ip ?? null,
    });
    return next;
  });
  resetMatchingConfigCache();
  return saved;
}
