import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../lib/prisma.js";
import { bestSetOrder, type MatchParts, type PairRow, pairSql, partsOf } from "./match-sql.js";
import { type MatchingConfig, RULE_IDS, type RuleId } from "./matching-config.js";

// Queries built on pairSql(). Routes call these; none of them check who the caller is.

/** Ranked lists stop here (offset paging over a capped list, like GET /tutors sort=match was planned). */
export const MATCH_LIST_CAP = 300;

type Db = Prisma.TransactionClient | typeof prisma;

// An OPEN requirement from an ACTIVE student that has no CONFIRMED or COMPLETED application.
export const eligibleRequirementSql = Prisma.sql`
  r.status::text = 'OPEN'
  AND EXISTS (SELECT 1 FROM account ra WHERE ra.id = s.account_id AND ra.status::text = 'ACTIVE')
  AND NOT EXISTS (
    SELECT 1 FROM application c
    WHERE c.requirement_id = r.id AND c.status::text IN ('CONFIRMED', 'COMPLETED'))
`;

// A tutor students may see: listed (is_listed already requires an ACTIVE account).
export const eligibleTutorSql = Prisma.sql`t.is_listed`;

// Pairs never recommended to each other: the student declined this tutor on this requirement, or
// either one has an open report against the other.
const notExcludedSql = Prisma.sql`
  NOT EXISTS (
    SELECT 1 FROM application d
    WHERE d.requirement_id = r.id AND d.tutor_id = t.id AND d.status::text = 'REJECTED')
  AND NOT EXISTS (
    SELECT 1 FROM report rp
    WHERE rp.status::text IN ('OPEN', 'UNDER_REVIEW')
      AND ((rp.reporter_id = s.account_id AND rp.target_account_id = t.account_id)
        OR (rp.reporter_id = t.account_id AND rp.target_account_id = s.account_id)))
`;

// ───────────────────────── tutor side ─────────────────────────

/** Requirements the set matches, best score first. Closed requirements are left out. */
export async function rankRequirementsForSet(
  cfg: MatchingConfig,
  tutorId: string,
  setId: string,
  offset: number,
  limit: number,
): Promise<{ rows: PairRow[]; hasMore: boolean }> {
  const take = Math.max(0, Math.min(limit, MATCH_LIST_CAP - offset));
  if (take === 0) return { rows: [], hasMore: false };
  const rows = await prisma.$queryRaw<PairRow[]>`
    SELECT m.* FROM (${pairSql(cfg, {
      where: Prisma.sql`tr.id = ${setId}::uuid AND tr.tutor_id = ${tutorId}::uuid AND ${eligibleRequirementSql}`,
    })}) m
    WHERE m.passes
    ORDER BY m.score DESC, m."requirementCreatedAt" DESC, m."requirementId" DESC
    OFFSET ${offset} LIMIT ${take + 1}
  `;
  const hasMore = rows.length > take && offset + take < MATCH_LIST_CAP;
  return { rows: rows.slice(0, take), hasMore };
}

/** Pair rows for one set and the given requirements (used to add scores to a newest-first page). */
export async function pairsForSet(
  cfg: MatchingConfig,
  tutorId: string,
  setId: string,
  requirementIds: string[],
): Promise<Map<string, PairRow>> {
  if (requirementIds.length === 0) return new Map();
  const rows = await prisma.$queryRaw<PairRow[]>`
    SELECT m.* FROM (${pairSql(cfg, {
      where: Prisma.sql`tr.id = ${setId}::uuid AND tr.tutor_id = ${tutorId}::uuid
        AND r.id IN (${Prisma.join(requirementIds.map((id) => Prisma.sql`${id}::uuid`))})`,
    })}) m
  `;
  return new Map(rows.map((row) => [row.requirementId, row]));
}

/** SQL for "requirement r passes set setId": drop into a WHERE that already has r in scope. */
export function setPassesRequirementSql(cfg: MatchingConfig, tutorId: string, setId: string) {
  return Prisma.sql`EXISTS (
    SELECT 1 FROM (${pairSql(cfg, {
      where: Prisma.sql`tr.id = ${setId}::uuid AND tr.tutor_id = ${tutorId}::uuid`,
    })}) m
    WHERE m."requirementId" = r.id AND m.passes
  )`;
}

// ───────────────────────── student side ─────────────────────────

export type TutorMatchRow = PairRow;

/** Listed tutors whose best active set matches the requirement, best score first. */
export async function recommendTutors(
  cfg: MatchingConfig,
  requirementId: string,
  offset: number,
  limit: number,
  opts: { assumeOnline?: boolean } = {},
): Promise<{ rows: TutorMatchRow[]; total: number }> {
  const pairs = pairSql(cfg, {
    where: Prisma.sql`r.id = ${requirementId}::uuid AND ${eligibleTutorSql} AND ${notExcludedSql}`,
    assumeOnline: opts.assumeOnline,
  });
  const take = Math.max(0, Math.min(limit, MATCH_LIST_CAP - offset));
  const rows = await prisma.$queryRaw<(TutorMatchRow & { total: number })[]>`
    WITH best AS (
      SELECT DISTINCT ON (m."tutorId") m.*
      FROM (${pairs}) m
      ORDER BY m."tutorId", ${bestSetOrder}
    )
    SELECT best.*, (count(*) OVER ())::int AS total
    FROM best
    WHERE best.passes
    ORDER BY best.score DESC, best."tutorId"
    OFFSET ${offset} LIMIT ${take}
  `;
  const total =
    rows[0]?.total ?? (offset === 0 ? 0 : await countMatchingTutors(cfg, requirementId));
  return { rows: rows.map(({ total: _t, ...row }) => row as TutorMatchRow), total };
}

/** How many listed tutors have at least one matching set. */
export async function countMatchingTutors(
  cfg: MatchingConfig,
  requirementId: string,
  opts: { assumeOnline?: boolean } = {},
): Promise<number> {
  const rows = await prisma.$queryRaw<{ n: number }[]>`
    SELECT count(DISTINCT m."tutorId")::int AS n FROM (${pairSql(cfg, {
      where: Prisma.sql`r.id = ${requirementId}::uuid AND ${eligibleTutorSql} AND ${notExcludedSql}`,
      assumeOnline: opts.assumeOnline,
    })}) m
    WHERE m.passes
  `;
  return rows[0]?.n ?? 0;
}

export type StudentSuggestion = { code: "ALLOW_ONLINE" | "ANY_GENDER"; extraTutors: number };

/**
 * When few tutors match, what one change to the requirement would add more. Only changes the student
 * can make themselves: allow online tuition, or accept any tutor gender.
 */
export async function studentSuggestions(
  cfg: MatchingConfig,
  requirement: { id: string; tuitionType: string | null; tutorGenderPref: string },
  current: number,
): Promise<StudentSuggestion[]> {
  const out: StudentSuggestion[] = [];
  if (requirement.tuitionType !== "Online") {
    const n = await countMatchingTutors(cfg, requirement.id, { assumeOnline: true });
    if (n > current) out.push({ code: "ALLOW_ONLINE", extraTutors: n - current });
  }
  if (requirement.tutorGenderPref !== "ANY" && cfg.rules.gender.mode === "REQUIRED") {
    const relaxed = withRule(cfg, "gender", "RANK");
    const n = await countMatchingTutors(relaxed, requirement.id);
    if (n > current) out.push({ code: "ANY_GENDER", extraTutors: n - current });
  }
  return out;
}

export type TutorGap = {
  code: "WIDER_LEVEL" | "OTHER_SUBJECTS" | "TEACH_ONLINE";
  requirements: number;
};

/** For a set that matches nothing: what one change to the set would show more open requirements. */
export async function tutorSetGaps(
  cfg: MatchingConfig,
  tutorId: string,
  set: { id: string; teachesOnline: boolean },
): Promise<TutorGap[]> {
  const count = async (c: MatchingConfig, assumeSetOnline = false) => {
    const rows = await prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM (${pairSql(c, {
        where: Prisma.sql`tr.id = ${set.id}::uuid AND tr.tutor_id = ${tutorId}::uuid AND ${eligibleRequirementSql}`,
        assumeSetOnline,
      })}) m
      WHERE m.passes
    `;
    return rows[0]?.n ?? 0;
  };
  const base = await count(cfg);
  const gaps: TutorGap[] = [];
  if (cfg.rules.level.mode === "REQUIRED") {
    const wider = { ...cfg, rules: { ...cfg.rules, level: { ...cfg.rules.level, slack: 2 } } };
    const n = await count(wider);
    if (n > base) gaps.push({ code: "WIDER_LEVEL", requirements: n - base });
  }
  if (cfg.rules.subject.mode === "REQUIRED") {
    const n = await count(withRule(cfg, "subject", "RANK"));
    if (n > base) gaps.push({ code: "OTHER_SUBJECTS", requirements: n - base });
  }
  if (!set.teachesOnline) {
    const n = await count(cfg, true);
    if (n > base) gaps.push({ code: "TEACH_ONLINE", requirements: n - base });
  }
  return gaps;
}

// ───────────────────────── applications ─────────────────────────

/** The tutor's best active set for the requirement (passing sets first), or null without sets. */
export async function bestSetForPair(
  db: Db,
  cfg: MatchingConfig,
  requirementId: string,
  tutorId: string,
): Promise<PairRow | null> {
  const rows = await db.$queryRaw<PairRow[]>`
    SELECT m.* FROM (${pairSql(cfg, {
      where: Prisma.sql`r.id = ${requirementId}::uuid AND tr.tutor_id = ${tutorId}::uuid`,
    })}) m
    ORDER BY ${bestSetOrder}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

// ───────────────────────── admin ─────────────────────────

export type ExplainSet = {
  setId: string;
  name: string;
  isDefault: boolean;
  studentCity: string | null;
  inZone: boolean;
  distanceKm: number | null;
  isOnline: boolean;
  sharedSubjects: number;
  totalSubjects: number;
  parts: MatchParts;
};

/** Every active set of the tutor against the requirement, best first. Ignores listing and reports. */
export async function explainPair(
  cfg: MatchingConfig,
  requirementId: string,
  tutorId: string,
): Promise<ExplainSet[]> {
  const rows = await prisma.$queryRaw<(PairRow & { name: string })[]>`
    SELECT m.*, tr2.name FROM (${pairSql(cfg, {
      where: Prisma.sql`r.id = ${requirementId}::uuid AND tr.tutor_id = ${tutorId}::uuid`,
    })}) m
    JOIN tutor_requirement tr2 ON tr2.id = m."setId"
    ORDER BY ${bestSetOrder}
  `;
  return rows.map((row) => ({
    setId: row.setId,
    name: row.name,
    isDefault: row.isDefault,
    studentCity: row.studentCity,
    inZone: row.inZone,
    distanceKm: row.distanceKm === null ? null : Number(row.distanceKm),
    isOnline: row.isOnline,
    sharedSubjects: row.sharedSubjects,
    totalSubjects: row.totalSubjects,
    parts: partsOf(row, cfg),
  }));
}

// "reach" is the city / online limit; the others are the REQUIRED rules of the config.
export type Blocker = "reach" | RuleId;

function blockersOf(cfg: MatchingConfig): Blocker[] {
  return ["reach", ...RULE_IDS.filter((id) => cfg.rules[id].mode === "REQUIRED")];
}

// For each blocker B: the pair passes every hard check except B.
function relaxedPassSql(cfg: MatchingConfig, skip: Blocker): Prisma.Sql {
  const checks = blockersOf(cfg)
    .filter((b) => b !== skip)
    .map((b) => (b === "reach" ? Prisma.sql`p.reach` : Prisma.raw(`p."pass_${b}"`)));
  return checks.length ? Prisma.join(checks, " AND ") : Prisma.sql`true`;
}

function perRequirementSql(cfg: MatchingConfig) {
  const blockers = blockersOf(cfg);
  return Prisma.sql`
    WITH reqs AS (
      SELECT r.id, r.created_at
      FROM tuition_requirement r JOIN student s ON s.id = r.student_id
      WHERE ${eligibleRequirementSql}
    ),
    pairs AS (${pairSql(cfg, { where: Prisma.sql`${eligibleRequirementSql} AND ${eligibleTutorSql}` })}),
    per_req AS (
      SELECT q.id, q.created_at,
             count(DISTINCT p."tutorId") FILTER (WHERE p.passes)::int AS tutors,
             ${Prisma.join(
               blockers.map(
                 (b) =>
                   Prisma.sql`COALESCE(bool_or(${relaxedPassSql(cfg, b)}), false) AS ${Prisma.raw(`"unblock_${b}"`)}`,
               ),
               ", ",
             )}
      FROM reqs q LEFT JOIN pairs p ON p."requirementId" = q.id
      GROUP BY q.id, q.created_at
    )
  `;
}

export type MatchingPreview = {
  version: number;
  openRequirements: number;
  requirementsWithNoTutor: number;
  requirementsWithFewTutors: number;
  requirementsWithManyTutors: number;
  listedTutors: number;
  tutorsWithAMatch: number;
  /** Requirements with no tutor that one blocker alone keeps empty. */
  blockers: { rule: Blocker; requirements: number }[];
};

export async function previewMatching(cfg: MatchingConfig): Promise<MatchingPreview> {
  const blockers = blockersOf(cfg);
  const [summary] = await prisma.$queryRaw<Record<string, number>[]>`
    ${perRequirementSql(cfg)}
    SELECT count(*)::int AS "openRequirements",
           count(*) FILTER (WHERE tutors = 0)::int AS "requirementsWithNoTutor",
           count(*) FILTER (WHERE tutors BETWEEN 1 AND 2)::int AS "requirementsWithFewTutors",
           count(*) FILTER (WHERE tutors >= 3)::int AS "requirementsWithManyTutors",
           ${Prisma.join(
             blockers.map(
               (b) =>
                 Prisma.sql`count(*) FILTER (WHERE tutors = 0 AND ${Prisma.raw(`"unblock_${b}"`)})::int AS ${Prisma.raw(`"blocker_${b}"`)}`,
             ),
             ", ",
           )}
    FROM per_req
  `;
  const [tutors] = await prisma.$queryRaw<{ listed: number; matched: number }[]>`
    SELECT (SELECT count(*) FROM tutor t WHERE ${eligibleTutorSql})::int AS listed,
           (SELECT count(DISTINCT m."tutorId") FROM (${pairSql(cfg, {
             where: Prisma.sql`${eligibleRequirementSql} AND ${eligibleTutorSql}`,
           })}) m WHERE m.passes)::int AS matched
  `;
  const row = summary ?? {};
  return {
    version: cfg.version,
    openRequirements: row.openRequirements ?? 0,
    requirementsWithNoTutor: row.requirementsWithNoTutor ?? 0,
    requirementsWithFewTutors: row.requirementsWithFewTutors ?? 0,
    requirementsWithManyTutors: row.requirementsWithManyTutors ?? 0,
    listedTutors: tutors?.listed ?? 0,
    tutorsWithAMatch: tutors?.matched ?? 0,
    blockers: blockers
      .map((rule) => ({ rule, requirements: row[`blocker_${rule}`] ?? 0 }))
      .filter((b) => b.requirements > 0)
      .sort((a, b) => b.requirements - a.requirements),
  };
}

export type UnmatchedRequirement = {
  id: string;
  createdAt: Date;
  /** Blockers that alone keep this requirement empty. Empty when it needs more than one change. */
  blockers: Blocker[];
};

/** OPEN requirements older than `olderThanHours` with no matching listed tutor, oldest first. */
export async function unmatchedRequirements(
  cfg: MatchingConfig,
  olderThanHours: number,
  limit: number,
): Promise<UnmatchedRequirement[]> {
  const blockers = blockersOf(cfg);
  const rows = await prisma.$queryRaw<
    (Record<string, boolean> & { id: string; created_at: Date })[]
  >`
    ${perRequirementSql(cfg)}
    SELECT * FROM per_req
    WHERE tutors = 0 AND created_at <= now() - make_interval(hours => ${olderThanHours}::int)
    ORDER BY created_at ASC, id ASC
    LIMIT ${limit}
  `;
  return rows.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    blockers: blockers.filter((b) => row[`unblock_${b}`] === true),
  }));
}

// ───────────────────────── helpers ─────────────────────────

export function withRule(
  cfg: MatchingConfig,
  id: RuleId,
  mode: "REQUIRED" | "RANK" | "OFF",
): MatchingConfig {
  return { ...cfg, rules: { ...cfg.rules, [id]: { ...cfg.rules[id], mode } } };
}
