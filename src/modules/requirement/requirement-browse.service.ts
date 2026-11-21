import { Prisma } from "../../generated/prisma/client.js";
import type { ApplicationStatus } from "../../generated/prisma/enums.js";
import { type Cursor, decodeCursor, encodeCursor } from "../../lib/cursor.js";
import { notFound, validationIssuesError } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import {
  pairsForSet,
  rankRequirementsForSet,
  setPassesRequirementSql,
  type TutorGap,
  tutorSetGaps,
} from "../matching/match.service.js";
import { type MatchReason, reasonsFor } from "../matching/match-reasons.js";
import { getMatchingConfig, type MatchingConfig } from "../matching/matching-config.js";
import type {
  BrowseRequirementPageResponse,
  BrowseRequirementResponse,
  RequirementBrowseQuery,
} from "./requirement-browse.schema.js";

const DEFAULT_LIMIT = 20;

type BrowseRow = {
  id: string;
  createdAt: Date;
  distanceKm: number | null;
  closed: boolean;
  myApplicationId: string | null;
  myApplicationStatus: ApplicationStatus | null;
  /** The caller's invite to this requirement (requirement_invite.id), null when not invited. */
  inviteId: string | null;
  invitedAt: Date | null;
};

type MatchView = { score: number; reasons: MatchReason[] };

// sort=match pages through the ranked list by offset. `v` is the config version the offset was
// taken under: after a config save the list may reorder, so the cursor restarts at 0.
type MatchCursor = { o: number; v: number };

function invalidCursor() {
  return validationIssuesError("Invalid cursor", [{ path: "cursor", message: "Invalid cursor" }]);
}

function encodeMatchCursor(cursor: MatchCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeMatchCursor(raw: string): MatchCursor {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!Number.isInteger(parsed?.o) || parsed.o < 0 || !Number.isInteger(parsed?.v)) {
      throw new Error("bad cursor");
    }
    return { o: parsed.o, v: parsed.v };
  } catch {
    throw invalidCursor();
  }
}

function decodeKeysetCursor(raw: string): Cursor {
  try {
    return decodeCursor(raw);
  } catch {
    throw invalidCursor();
  }
}

type SetContext = { setId: string; cfg: MatchingConfig };

// Each filter is a Prisma.sql fragment (or Prisma.empty), so every user value is a bound parameter.
// Manual filters apply to scope nearby and all only; set and invited ignore them.
function browseFilters(
  tutorId: string,
  query: RequirementBrowseQuery,
  set: SetContext | null,
  ids?: string[],
) {
  const manual = query.scope === "nearby" || query.scope === "all";
  const scopeFilter = set
    ? Prisma.sql`AND ${setPassesRequirementSql(set.cfg, tutorId, set.setId)}`
    : query.scope === "invited"
      ? Prisma.sql`AND ri.id IS NOT NULL`
      : Prisma.empty;
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
  const ranked = ids ? Prisma.sql`AND r.id = ANY(${ids}::uuid[])` : Prisma.empty;
  return { scopeFilter, nearby, curriculum, levelCode, subjectId, areaId, ranked };
}

// Row fields every mode returns. Callers add their own filter, keyset and order.
async function loadRows(
  tutorId: string,
  filters: ReturnType<typeof browseFilters>,
  keyset: Prisma.Sql,
  orderBy: Prisma.Sql,
  take: number,
): Promise<BrowseRow[]> {
  return prisma.$queryRaw<BrowseRow[]>`
    SELECT r.id,
           r.created_at AS "createdAt",
           (ROUND(ST_Distance(tl.geog, sl.geog) / 500.0) * 0.5)::float8 AS "distanceKm",
           EXISTS (
             SELECT 1 FROM application c
             WHERE c.requirement_id = r.id AND c.status::text IN ('CONFIRMED', 'COMPLETED')
           ) AS closed,
           a.id AS "myApplicationId",
           a.status AS "myApplicationStatus",
           ri.id AS "inviteId",
           ri.created_at AS "invitedAt"
    FROM tuition_requirement r
    JOIN student s ON s.id = r.student_id
    JOIN account acc ON acc.id = s.account_id
    LEFT JOIN student_location sl ON sl.student_id = s.id
    LEFT JOIN tutor_location tl ON tl.tutor_id = ${tutorId}::uuid
    LEFT JOIN application a ON a.requirement_id = r.id AND a.tutor_id = ${tutorId}::uuid
    LEFT JOIN requirement_invite ri ON ri.requirement_id = r.id AND ri.tutor_id = ${tutorId}::uuid
    WHERE r.status::text = 'OPEN'
      AND acc.status::text = 'ACTIVE'
      ${filters.scopeFilter}
      ${filters.ranked}
      ${filters.nearby}
      ${filters.curriculum}
      ${filters.levelCode}
      ${filters.subjectId}
      ${filters.areaId}
      ${keyset}
    ORDER BY ${orderBy}
    LIMIT ${take}
  `;
}

// Set mode: the set must be the caller's own active set. Checked before the listing query runs.
async function assertOwnActiveSet(tutorId: string, setId: string | undefined) {
  const set = setId
    ? await prisma.tutorRequirement.findFirst({
        where: { id: setId, tutorId, isActive: true },
        select: { id: true, teachesOnline: true },
      })
    : null;
  if (!set) throw notFound("Requirement set not found");
  return set;
}

// The keyset cursor of a row: the requirement for newest, the invite for invited.
function cursorOf(row: BrowseRow, invited: boolean): Cursor {
  if (invited && row.invitedAt && row.inviteId) {
    return { createdAt: row.invitedAt, id: row.inviteId };
  }
  return { createdAt: row.createdAt, id: row.id };
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

  const set = query.scope === "set" ? await assertOwnActiveSet(tutor.id, query.setId) : null;
  const cfg = set ? await getMatchingConfig() : null;
  const limit = query.limit ?? DEFAULT_LIMIT;
  const invited = query.scope === "invited";

  let listed: BrowseRow[];
  let nextCursor: string | null = null;
  const matches = new Map<string, MatchView>();

  if (set && cfg && query.sort === "match") {
    // Ranked by the engine: best score first, then newest. Closed requirements are not ranked.
    let offset = 0;
    if (query.cursor) {
      const decoded = decodeMatchCursor(query.cursor);
      if (decoded.v === cfg.version) offset = decoded.o;
    }
    const ranked = await rankRequirementsForSet(cfg, tutor.id, set.id, offset, limit);
    const ids = ranked.rows.map((row) => row.requirementId);
    const rows = ids.length
      ? await loadRows(
          tutor.id,
          browseFilters(tutor.id, query, null, ids),
          Prisma.empty,
          Prisma.sql`r.created_at DESC, r.id DESC`,
          ids.length,
        )
      : [];
    const byId = new Map(rows.map((row) => [row.id, row]));
    // The ranked order is the page order.
    listed = ids.flatMap((id) => {
      const row = byId.get(id);
      return row ? [row] : [];
    });
    for (const pair of ranked.rows) {
      matches.set(pair.requirementId, {
        score: pair.score,
        reasons: reasonsFor(pair, cfg, "TUTOR"),
      });
    }
    if (ranked.hasMore) {
      nextCursor = encodeMatchCursor({ o: offset + ranked.rows.length, v: cfg.version });
    }
  } else {
    const cursor = query.cursor ? decodeKeysetCursor(query.cursor) : null;
    const keyset = cursor
      ? invited
        ? Prisma.sql`AND (ri.created_at, ri.id) < (${cursor.createdAt}, ${cursor.id}::uuid)`
        : Prisma.sql`AND (r.created_at, r.id) < (${cursor.createdAt}, ${cursor.id}::uuid)`
      : Prisma.empty;
    const orderBy = invited
      ? Prisma.sql`ri.created_at DESC, ri.id DESC`
      : Prisma.sql`r.created_at DESC, r.id DESC`;
    const filters = browseFilters(tutor.id, query, set && cfg ? { setId: set.id, cfg } : null);
    const rows = await loadRows(tutor.id, filters, keyset, orderBy, limit + 1);

    listed = rows.slice(0, limit);
    const last = listed[listed.length - 1];
    if (rows.length > limit && last) nextCursor = encodeCursor(cursorOf(last, invited));

    if (set && cfg) {
      // The page is newest first; the engine adds each row's score and reasons.
      const pairs = await pairsForSet(
        cfg,
        tutor.id,
        set.id,
        listed.map((row) => row.id),
      );
      for (const [id, pair] of pairs) {
        matches.set(id, { score: pair.score, reasons: reasonsFor(pair, cfg, "TUTOR") });
      }
    }
  }

  // What to change in the set when nothing shows on the first page.
  let gaps: TutorGap[] = [];
  if (set && cfg && !query.cursor && listed.length === 0) {
    gaps = await tutorSetGaps(cfg, tutor.id, { id: set.id, teachesOnline: set.teachesOnline });
  }

  const [requirementRows, subjectRows] = await Promise.all([
    listed.length
      ? prisma.tuitionRequirement.findMany({ where: { id: { in: listed.map((r) => r.id) } } })
      : Promise.resolve([]),
    listed.length
      ? prisma.requirementSubject.findMany({
          where: { requirementId: { in: listed.map((r) => r.id) } },
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
  for (const row of listed) {
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
      invitedAt: row.invitedAt,
      match: cfg ? (matches.get(r.id) ?? null) : null,
    });
  }

  return {
    requirements,
    nextCursor,
    noServiceArea: tutor._count.zones === 0 && tutor._count.areas === 0,
    matchVersion: cfg ? cfg.version : null,
    gaps,
  };
}
