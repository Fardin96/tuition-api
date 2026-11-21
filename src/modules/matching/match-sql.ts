import { Prisma } from "../../generated/prisma/client.js";
import { type MatchingConfig, RULE_IDS, type RuleId, type RuleMode } from "./matching-config.js";

// The one definition of "does tutor set tr match requirement r, and how well". Every caller (tutor
// browse, student recommendations, application scoring, admin explain and preview) selects from
// pairSql(), so pass/fail and score cannot drift between them.
//
// Hard limit, every mode (`reach`):
//   Online requirement (tuition_type 'Online'): the set teaches online.
//   Home tuition: the set can teach at home (it has zones, or is not online-only), and
//     - student pin inside an active city: the tutor's home pin is inside that city or within
//       cityEdgeKm of its edge, or one of the zones counted below has its centre there;
//     - student pin outside every city: tutor home in the same district within outsideCityKm, or a
//       zone centre within outsideCityKm of the pin;
//     - no usable student pin: the requirement's area is one of the tutor's areas.
//   Zones counted: the set's zones, or all of the tutor's zones when the set has none.
// Rules (matching-config.ts): each gives pass_<rule> and part_<rule> (0..1). REQUIRED rules must pass.
// Score = round(100 * sum(weight * part) / sum(weight)) over the rules that are not OFF.
//
// Aliases callers may use in `where`: r (tuition_requirement), s (student), sl (student_location),
// tr (tutor_requirement, active sets only), t (tutor), tl (tutor_location).

export type PairOptions = {
  /** Conditions on the base tables, without a leading AND. */
  where: Prisma.Sql;
  /** What-if: treat the requirement as online. */
  assumeOnline?: boolean;
  /** What-if: treat the set as teaching online. */
  assumeSetOnline?: boolean;
};

const col = (prefix: "pass" | "part", id: RuleId) => Prisma.raw(`"${prefix}_${id}"`);

export function ruleWeightTotal(cfg: MatchingConfig): number {
  return RULE_IDS.reduce(
    (sum, id) => sum + (cfg.rules[id].mode === "OFF" ? 0 : cfg.rules[id].weight),
    0,
  );
}

function curriculumEquivalentSql(cfg: MatchingConfig): Prisma.Sql {
  if (cfg.curriculumEquivalents.length === 0) return Prisma.sql`false`;
  return Prisma.join(
    cfg.curriculumEquivalents.map(
      (group) =>
        Prisma.sql`(r.curriculum::text = ANY(${group}::text[]) AND tr.curricula::text[] && ${group}::text[])`,
    ),
    " OR ",
  );
}

/** A SELECT (no parentheses) with one row per (requirement, active set) pair that satisfies `where`. */
export function pairSql(cfg: MatchingConfig, opts: PairOptions): Prisma.Sql {
  const edgeM = cfg.cityEdgeKm * 1000;
  const outsideM = cfg.outsideCityKm * 1000;
  const scoreM = cfg.distanceScoreKm * 1000;
  const slack = cfg.rules.level.slack;
  const total = ruleWeightTotal(cfg);

  const passes = Prisma.join(
    [
      Prisma.sql`x.reach`,
      ...RULE_IDS.filter((id) => cfg.rules[id].mode === "REQUIRED").map(
        (id) => Prisma.sql`x.${col("pass", id)}`,
      ),
    ],
    " AND ",
  );
  const weighted = RULE_IDS.filter((id) => cfg.rules[id].mode !== "OFF").map(
    (id) => Prisma.sql`${cfg.rules[id].weight}::float8 * x.${col("part", id)}`,
  );
  const score =
    total > 0 && weighted.length > 0
      ? Prisma.sql`round(100 * (${Prisma.join(weighted, " + ")}) / ${total}::float8)::int`
      : Prisma.sql`0`;
  const subjectPass = cfg.rules.subject.requireAll
    ? Prisma.sql`(subj.total_subjects > 0 AND subj.shared_subjects = subj.total_subjects)`
    : Prisma.sql`subj.shared_subjects >= 1`;

  return Prisma.sql`
    SELECT r.id AS "requirementId",
           tr.id AS "setId",
           tr.tutor_id AS "tutorId",
           tr.is_default AS "isDefault",
           tr.created_at AS "setCreatedAt",
           r.created_at AS "requirementCreatedAt",
           subj.shared_subjects AS "sharedSubjects",
           subj.total_subjects AS "totalSubjects",
           b.is_online AS "isOnline",
           sc.student_city AS "studentCity",
           zn.in_zone AS "inZone",
           (CASE WHEN dist.d_m IS NULL THEN NULL ELSE round(dist.d_m / 500.0) * 0.5 END)::float8 AS "distanceKm",
           x.reach,
           ${Prisma.join(
             RULE_IDS.map((id) => Prisma.sql`x.${col("pass", id)}, x.${col("part", id)}`),
             ", ",
           )},
           (${passes}) AS passes,
           ${score} AS score
    FROM tuition_requirement r
    JOIN student s ON s.id = r.student_id
    LEFT JOIN student_location sl ON sl.student_id = s.id
    JOIN tutor_requirement tr ON tr.is_active
    JOIN tutor t ON t.id = tr.tutor_id
    LEFT JOIN tutor_location tl ON tl.tutor_id = t.id
    CROSS JOIN LATERAL (
      SELECT (sl.geog IS NOT NULL AND NOT sl.needs_readdress) AS s_pin,
             (tl.geog IS NOT NULL AND NOT tl.needs_readdress) AS t_pin,
             (${opts.assumeOnline === true} OR r.tuition_type = 'Online') AS is_online,
             (${opts.assumeSetOnline === true} OR tr.teaches_online) AS set_online,
             EXISTS (SELECT 1 FROM tutor_requirement_zone trz WHERE trz.requirement_id = tr.id) AS has_set_zones,
             r.area_id IN (SELECT ta.area_id FROM tutor_area ta WHERE ta.tutor_id = tr.tutor_id) AS area_match
    ) b
    CROSS JOIN LATERAL (
      SELECT (SELECT c.slug FROM city c
              WHERE b.s_pin AND c.is_active AND ST_Covers(c.boundary, sl.geog)
              ORDER BY c.slug LIMIT 1) AS student_city
    ) sc
    CROSS JOIN LATERAL (
      SELECT COALESCE(bool_or(b.s_pin AND ST_DWithin(sl.geog, z.center, z.radius_m)), false) AS in_zone,
             COALESCE(bool_or(sc.student_city IS NOT NULL AND EXISTS (
               SELECT 1 FROM city c WHERE c.slug = sc.student_city AND ST_DWithin(c.boundary, z.center, ${edgeM}::float8)
             )), false) AS zone_in_city,
             COALESCE(bool_or(b.s_pin AND ST_DWithin(sl.geog, z.center, ${outsideM}::float8)), false) AS zone_near,
             min(CASE WHEN b.s_pin THEN greatest(ST_Distance(sl.geog, z.center) - z.radius_m, 0) END) AS zone_gap_m
      FROM tutor_zone z
      WHERE z.tutor_id = tr.tutor_id
        AND (NOT b.has_set_zones OR EXISTS (
          SELECT 1 FROM tutor_requirement_zone trz WHERE trz.requirement_id = tr.id AND trz.zone_id = z.id))
    ) zn
    CROSS JOIN LATERAL (
      SELECT least(
               CASE WHEN b.s_pin AND b.t_pin THEN ST_Distance(sl.geog, tl.geog) END,
               zn.zone_gap_m
             )::float8 AS d_m
    ) dist
    CROSS JOIN LATERAL (
      SELECT (SELECT count(*) FROM requirement_subject rs WHERE rs.requirement_id = r.id)::int AS total_subjects,
             (SELECT count(*) FROM requirement_subject rs
              JOIN tutor_requirement_subject trs ON trs.subject_id = rs.subject_id AND trs.requirement_id = tr.id
              WHERE rs.requirement_id = r.id)::int AS shared_subjects
    ) subj
    CROSS JOIN LATERAL (
      SELECT greatest(tr.level_min - r.level_code, r.level_code - tr.level_max, 0) AS level_gap,
             bit_count((r.available_days & tr.available_days)::int::bit(7)) >= COALESCE(r.days_per_week, 1) AS days_ok,
             (r.time_of_day IS NULL OR (r.time_of_day >= tr.time_from AND r.time_of_day < tr.time_to)) AS time_ok,
             COALESCE(r.student_count, 1) <= tr.max_students AS seats_ok,
             (r.hire_by_date IS NULL OR tr.available_from <= r.hire_by_date) AS start_ok,
             COALESCE(CASE
               WHEN b.is_online THEN b.set_online
               WHEN NOT (b.has_set_zones OR NOT b.set_online) THEN false
               WHEN sc.student_city IS NOT NULL THEN
                 (b.t_pin AND EXISTS (
                   SELECT 1 FROM city c WHERE c.slug = sc.student_city AND ST_DWithin(c.boundary, tl.geog, ${edgeM}::float8)))
                 OR zn.zone_in_city
               WHEN b.s_pin THEN
                 (b.t_pin AND tl.district_code = sl.district_code AND ST_DWithin(tl.geog, sl.geog, ${outsideM}::float8))
                 OR zn.zone_near
               ELSE b.area_match
             END, false) AS reach
    ) g
    CROSS JOIN LATERAL (
      SELECT g.reach AS reach,
             COALESCE((${cfg.admissionIgnoresCurriculum} AND r.level_code = 13)
               OR r.curriculum = ANY(tr.curricula)
               OR ${curriculumEquivalentSql(cfg)}, false) AS "pass_curriculum",
             (CASE WHEN COALESCE((${cfg.admissionIgnoresCurriculum} AND r.level_code = 13)
               OR r.curriculum = ANY(tr.curricula)
               OR ${curriculumEquivalentSql(cfg)}, false) THEN 1 ELSE 0 END)::float8 AS "part_curriculum",
             COALESCE(g.level_gap <= ${slack}, false) AS "pass_level",
             COALESCE(greatest(0, 1 - g.level_gap / 3.0), 0)::float8 AS "part_level",
             ${subjectPass} AS "pass_subject",
             (CASE WHEN subj.total_subjects = 0 THEN 0
                   ELSE subj.shared_subjects::float8 / subj.total_subjects END)::float8 AS "part_subject",
             ((r.academic_group IS NULL OR cardinality(tr.academic_groups) = 0
                OR r.academic_group = ANY(tr.academic_groups))
              AND (cardinality(r.admission_targets) = 0 OR cardinality(tr.admission_targets) = 0
                OR r.admission_targets && tr.admission_targets)) AS "pass_groupTarget",
             (CASE WHEN (r.academic_group IS NULL OR cardinality(tr.academic_groups) = 0
                OR r.academic_group = ANY(tr.academic_groups))
              AND (cardinality(r.admission_targets) = 0 OR cardinality(tr.admission_targets) = 0
                OR r.admission_targets && tr.admission_targets) THEN 1 ELSE 0 END)::float8 AS "part_groupTarget",
             (b.is_online OR zn.in_zone OR (NOT b.has_set_zones AND COALESCE(b.area_match, false))) AS "pass_location",
             (CASE WHEN b.is_online OR zn.in_zone THEN 1
                   WHEN dist.d_m IS NULL THEN 0.5
                   ELSE greatest(0, 1 - dist.d_m / ${scoreM}::float8) END)::float8 AS "part_location",
             (r.tutor_gender_pref::text = 'ANY' OR r.tutor_gender_pref::text = t.gender::text) AS "pass_gender",
             (CASE WHEN r.tutor_gender_pref::text = 'ANY' OR r.tutor_gender_pref::text = t.gender::text
                   THEN 1 ELSE 0 END)::float8 AS "part_gender",
             (r.salary IS NULL OR tr.min_salary IS NULL OR r.salary >= tr.min_salary) AS "pass_salary",
             (CASE WHEN r.salary IS NULL OR tr.min_salary IS NULL OR r.salary >= tr.min_salary THEN 1
                   ELSE greatest(0, r.salary::float8 / NULLIF(tr.min_salary, 0)) END)::float8 AS "part_salary",
             (g.days_ok AND g.time_ok) AS "pass_schedule",
             (0.5 * g.days_ok::int + 0.5 * g.time_ok::int)::float8 AS "part_schedule",
             (g.seats_ok AND g.start_ok) AS "pass_capacity",
             (0.5 * g.seats_ok::int + 0.5 * g.start_ok::int)::float8 AS "part_capacity",
             true AS "pass_quality",
             (0.7 * greatest(0, ((3 * 4.0 + t.rating_avg::float8 * t.rating_count) / (3 + t.rating_count) - 1) / 4)
              + 0.3 * (t.verification_status::text = 'APPROVED')::int)::float8 AS "part_quality",
             true AS "pass_recency",
             exp(-extract(epoch FROM (now() - r.created_at)) / (14 * 86400.0))::float8 AS "part_recency"
    ) x
    WHERE ${opts.where}
  `;
}

export type RuleResult = { mode: RuleMode; pass: boolean; part: number };

export type PairRow = {
  requirementId: string;
  setId: string;
  tutorId: string;
  isDefault: boolean;
  setCreatedAt: Date;
  requirementCreatedAt: Date;
  sharedSubjects: number;
  totalSubjects: number;
  isOnline: boolean;
  studentCity: string | null;
  inZone: boolean;
  distanceKm: number | null;
  reach: boolean;
  passes: boolean;
  score: number;
} & Record<`pass_${RuleId}`, boolean> &
  Record<`part_${RuleId}`, number>;

/** What application.match_parts stores and admin explain returns. */
export type MatchParts = {
  version: number;
  score: number;
  passes: boolean;
  reach: boolean;
  rules: Record<RuleId, RuleResult>;
};

export function partsOf(row: PairRow, cfg: MatchingConfig): MatchParts {
  const rules = {} as Record<RuleId, RuleResult>;
  for (const id of RULE_IDS) {
    rules[id] = {
      mode: cfg.rules[id].mode,
      pass: row[`pass_${id}`],
      part: Math.round(Number(row[`part_${id}`]) * 1000) / 1000,
    };
  }
  return {
    version: cfg.version,
    score: Number(row.score),
    passes: row.passes,
    reach: row.reach,
    rules,
  };
}

/** Best set first: passing, then score, then default, then most shared subjects, then newest. */
export const bestSetOrder = Prisma.sql`
  m.passes DESC, m.score DESC, m."isDefault" DESC, m."sharedSubjects" DESC, m."setCreatedAt" DESC, m."setId" DESC
`;
