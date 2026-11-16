import { Prisma } from "../../generated/prisma/client.js";
import type { ApplicationStatus } from "../../generated/prisma/enums.js";
import { type Cursor, decodeCursor, encodeCursor } from "../../lib/cursor.js";
import { notFound } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import type {
  BrowseRequirementPageResponse,
  BrowseRequirementResponse,
  RequirementBrowseQuery,
} from "./requirement-browse.schema.js";
import { setMatchesRequirementSql } from "./set-match.js";

const DEFAULT_LIMIT = 20;

type BrowseRow = {
  id: string;
  createdAt: Date;
  distanceKm: number | null;
  closed: boolean;
  myApplicationId: string | null;
  myApplicationStatus: ApplicationStatus | null;
};

// Set mode: the set joins as `tr`, and its four-rule fragment replaces the nearby rule and the
// manual filters.
// Each optional filter is a Prisma.sql fragment (or Prisma.empty), so every user value is a bound parameter.
function browseFilters(tutorId: string, query: RequirementBrowseQuery, cursor: Cursor | null) {
  const manual = query.scope !== "set";
  const setJoin =
    query.scope === "set" && query.setId
      ? Prisma.sql`JOIN tutor_requirement tr
          ON tr.id = ${query.setId}::uuid AND tr.tutor_id = ${tutorId}::uuid AND tr.is_active`
      : Prisma.empty;
  const setMatch =
    query.scope === "set" ? Prisma.sql`AND ${setMatchesRequirementSql()}` : Prisma.empty;
  const nearby =
    query.scope === "nearby"
      ? Prisma.sql`AND (
          (sl.geog IS NOT NULL AND NOT sl.needs_readdress AND EXISTS (
            SELECT 1 FROM tutor_zone z
            WHERE z.tutor_id = ${tutorId}::uuid
              AND ST_DWithin(sl.geog, z.center, z.radius_m)))
          OR r.area_id IN (SELECT ta.area_id FROM tutor_area ta WHERE ta.tutor_id = ${tutorId}::uuid)
        )`
      : Prisma.empty;
  const curriculum =
    manual && query.curriculum
      ? Prisma.sql`AND r.curriculum::text = ${query.curriculum}`
      : Prisma.empty;
  const levelCode =
    manual && query.levelCode !== undefined
      ? Prisma.sql`AND r.level_code = ${query.levelCode}`
      : Prisma.empty;
  const subjectId =
    manual && query.subjectId
      ? Prisma.sql`AND EXISTS (
        SELECT 1 FROM requirement_subject rs
        WHERE rs.requirement_id = r.id AND rs.subject_id = ${query.subjectId})`
      : Prisma.empty;
  const areaId =
    manual && query.areaId !== undefined
      ? Prisma.sql`AND r.area_id = ${query.areaId}`
      : Prisma.empty;
  const keyset = cursor
    ? Prisma.sql`AND (r.created_at, r.id) < (${cursor.createdAt}, ${cursor.id}::uuid)`
    : Prisma.empty;
  return { setJoin, setMatch, nearby, curriculum, levelCode, subjectId, areaId, keyset };
}

// Set mode: the set must be the caller's own active set. Checked before the listing query runs.
async function assertOwnActiveSet(tutorId: string, setId: string | undefined) {
  const set = setId
    ? await prisma.tutorRequirement.findFirst({
        where: { id: setId, tutorId, isActive: true },
        select: { id: true },
      })
    : null;
  if (!set) throw notFound("Requirement set not found");
}

export async function browseRequirements(
  accountId: string,
  query: RequirementBrowseQuery,
): Promise<BrowseRequirementPageResponse> {
  const tutor = await prisma.tutor.findUnique({
    where: { accountId },
    select: { id: true, _count: { select: { zones: true, areas: true } } },
  });
  if (!tutor) throw notFound("Tutor profile not found");
  if (query.scope === "set") await assertOwnActiveSet(tutor.id, query.setId);

  const limit = query.limit ?? DEFAULT_LIMIT;
  const f = browseFilters(tutor.id, query, query.cursor ? decodeCursor(query.cursor) : null);

  const rows = await prisma.$queryRaw<BrowseRow[]>`
    SELECT r.id,
           r.created_at AS "createdAt",
           (ROUND(ST_Distance(tl.geog, sl.geog) / 500.0) * 0.5)::float8 AS "distanceKm",
           EXISTS (
             SELECT 1 FROM application c
             WHERE c.requirement_id = r.id AND c.status::text IN ('CONFIRMED', 'COMPLETED')
           ) AS closed,
           a.id AS "myApplicationId",
           a.status AS "myApplicationStatus"
    FROM tuition_requirement r
    JOIN student s ON s.id = r.student_id
    JOIN account acc ON acc.id = s.account_id
    LEFT JOIN student_location sl ON sl.student_id = s.id
    LEFT JOIN tutor_location tl ON tl.tutor_id = ${tutor.id}::uuid
    LEFT JOIN application a ON a.requirement_id = r.id AND a.tutor_id = ${tutor.id}::uuid
    ${f.setJoin}
    WHERE r.status::text = 'OPEN'
      AND acc.status::text = 'ACTIVE'
      ${f.setMatch}
      ${f.nearby}
      ${f.curriculum}
      ${f.levelCode}
      ${f.subjectId}
      ${f.areaId}
      ${f.keyset}
    ORDER BY r.created_at DESC, r.id DESC
    LIMIT ${limit + 1}
  `;

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const ids = page.map((r) => r.id);

  const [requirementRows, subjectRows] = await Promise.all([
    ids.length
      ? prisma.tuitionRequirement.findMany({ where: { id: { in: ids } } })
      : Promise.resolve([]),
    ids.length
      ? prisma.requirementSubject.findMany({
          where: { requirementId: { in: ids } },
          orderBy: { subjectId: "asc" },
          select: { requirementId: true, subjectId: true },
        })
      : Promise.resolve([]),
  ]);

  const requirementById = new Map(requirementRows.map((r) => [r.id, r]));
  const subjectsById = new Map<string, number[]>();
  for (const s of subjectRows) {
    const list = subjectsById.get(s.requirementId) ?? [];
    list.push(s.subjectId);
    subjectsById.set(s.requirementId, list);
  }

  const requirements: BrowseRequirementResponse[] = [];
  for (const row of page) {
    const r = requirementById.get(row.id);
    if (!r) continue;
    requirements.push({
      id: r.id,
      areaId: r.areaId,
      subjectIds: subjectsById.get(r.id) ?? [],
      curriculum: r.curriculum,
      levelCode: r.levelCode,
      academicGroup: r.academicGroup,
      admissionTargets: r.admissionTargets,
      isRetaker: r.isRetaker,
      levelNote: r.levelNote,
      timeOfDay: r.timeOfDay ? r.timeOfDay.toISOString().slice(11, 16) : null,
      daysPerWeek: r.daysPerWeek,
      availableDays: r.availableDays,
      salary: r.salary,
      studentCount: r.studentCount,
      hireByDate: r.hireByDate ? r.hireByDate.toISOString().slice(0, 10) : null,
      tutorGenderPref: r.tutorGenderPref,
      tuitionType: r.tuitionType,
      createdAt: r.createdAt,
      distanceKm: row.distanceKm === null ? null : Number(row.distanceKm),
      closed: row.closed,
      myApplication:
        row.myApplicationId && row.myApplicationStatus
          ? { id: row.myApplicationId, status: row.myApplicationStatus }
          : null,
    });
  }

  return {
    requirements,
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
    noServiceArea: tutor._count.zones === 0 && tutor._count.areas === 0,
  };
}
