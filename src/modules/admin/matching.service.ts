import { Prisma } from "../../generated/prisma/client.js";
import { writeAudit } from "../../lib/admin.js";
import { notFound, validationIssuesError } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { explainPair, previewMatching, unmatchedRequirements } from "../matching/match.service.js";
import {
  getMatchingConfig,
  getMatchingConfigRecord,
  type MatchingConfigInput,
  RULE_ALLOWED_MODES,
  saveMatchingConfig,
} from "../matching/matching-config.js";
import type { AdminCity, UpsertCityInput } from "./matching.schema.js";

// Thin layer over the matching engine for the admin pages. Routes check the caller's role.

export async function getAdminMatchingConfig() {
  const record = await getMatchingConfigRecord();
  return { ...record, ruleModes: RULE_ALLOWED_MODES };
}

export async function saveAdminMatchingConfig(
  input: MatchingConfigInput,
  admin: { accountId: string },
  ip: string | undefined,
) {
  await saveMatchingConfig(input, admin, ip);
  return getAdminMatchingConfig();
}

/** Current config and the posted draft, both as previews. The draft keeps the current version. */
export async function previewAdminMatching(input: MatchingConfigInput) {
  // Read the stored row, not the 30 s cache, so the admin compares against what was last saved.
  const current = (await getMatchingConfigRecord()).config;
  const currentPreview = await previewMatching(current);
  const draftPreview = await previewMatching({ ...input, version: current.version });
  return { current: currentPreview, draft: draftPreview };
}

export async function explainAdminMatch(requirementId: string, tutorId: string) {
  const requirement = await prisma.tuitionRequirement.findUnique({
    where: { id: requirementId },
    select: { id: true, curriculum: true, levelCode: true, tuitionType: true, status: true },
  });
  if (!requirement) throw notFound("Requirement not found");
  const tutor = await prisma.tutor.findUnique({
    where: { id: tutorId },
    select: { id: true, name: true, isListed: true },
  });
  if (!tutor) throw notFound("Tutor not found");

  const cfg = await getMatchingConfig();
  const sets = await explainPair(cfg, requirementId, tutorId);
  return {
    version: cfg.version,
    requirement,
    tutor,
    sets,
  };
}

export async function listUnmatchedRequirements(olderThanHours: number, limit: number) {
  const cfg = await getMatchingConfig();
  const found = await unmatchedRequirements(cfg, olderThanHours, limit);
  if (found.length === 0) return { requirements: [] };

  const rows = await prisma.tuitionRequirement.findMany({
    where: { id: { in: found.map((row) => row.id) } },
    select: {
      id: true,
      curriculum: true,
      levelCode: true,
      areaId: true,
      tuitionType: true,
      student: { select: { name: true } },
      subjects: { select: { subjectId: true }, orderBy: { subjectId: "asc" } },
    },
  });
  const byId = new Map(rows.map((row) => [row.id, row] as const));

  // Keep the order unmatchedRequirements returned (oldest first).
  const requirements = found.flatMap((item) => {
    const row = byId.get(item.id);
    if (!row) return [];
    return [
      {
        id: row.id,
        createdAt: item.createdAt,
        studentName: row.student.name,
        curriculum: row.curriculum,
        levelCode: row.levelCode,
        subjectIds: row.subjects.map((s) => s.subjectId),
        areaId: row.areaId,
        tuitionType: row.tuitionType,
        blockers: item.blockers,
      },
    ];
  });
  return { requirements };
}

// ───────────────────────── cities ─────────────────────────

type CityRow = Omit<AdminCity, "areaKm2"> & { areaKm2: number };

// ST_Area on a geography is in square metres.
const cityColumns = Prisma.sql`
  slug, name, district_code AS "districtCode", is_active AS "isActive",
  ST_Area(boundary) / 1000000 AS "areaKm2", updated_at AS "updatedAt"
`;

// Cities are 5 to 2000 km2: a neighbourhood is too small to match on, a whole division too large.
const MIN_CITY_KM2 = 5;
const MAX_CITY_KM2 = 2000;

function toCity(row: CityRow): AdminCity {
  return { ...row, areaKm2: Number(row.areaKm2) };
}

function boundaryError(message: string) {
  return validationIssuesError("Invalid city boundary", [{ path: "boundary", message }]);
}

export async function listCities(): Promise<AdminCity[]> {
  const rows = await prisma.$queryRaw<CityRow[]>`
    SELECT ${cityColumns} FROM city ORDER BY name ASC, slug ASC
  `;
  return rows.map(toCity);
}

// Parses and checks the boundary before any write. PostGIS rejects a malformed GeoJSON with a
// query error, which is a 400 here, not a server error.
async function checkBoundary(json: string): Promise<number> {
  let rows: { valid: boolean; areaKm2: number }[];
  try {
    rows = await prisma.$queryRaw<{ valid: boolean; areaKm2: number }[]>`
      SELECT ST_IsValid(g) AS valid, ST_Area(g::geography) / 1000000 AS "areaKm2"
      FROM (SELECT ST_Multi(ST_GeomFromGeoJSON(${json})) AS g) s
    `;
  } catch (err) {
    // P2010: the raw query failed, which here means PostGIS rejected the geometry.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2010") {
      throw boundaryError("Boundary is not a valid GeoJSON polygon");
    }
    throw err;
  }
  const row = rows[0];
  if (!row?.valid) {
    throw boundaryError("Boundary must be a valid polygon that does not cross itself");
  }
  const areaKm2 = Number(row.areaKm2);
  if (!(areaKm2 >= MIN_CITY_KM2 && areaKm2 <= MAX_CITY_KM2)) {
    throw boundaryError(`Boundary must cover ${MIN_CITY_KM2} to ${MAX_CITY_KM2} km2`);
  }
  return areaKm2;
}

// Audit fields for a city, without the boundary (it is large and the area says what matters).
function cityAuditFields(city: AdminCity) {
  return {
    name: city.name,
    districtCode: city.districtCode,
    isActive: city.isActive,
    areaKm2: Math.round(city.areaKm2 * 100) / 100,
  };
}

export async function upsertCity(
  slug: string,
  input: UpsertCityInput,
  admin: { accountId: string },
  ip: string | undefined,
): Promise<AdminCity> {
  const json = JSON.stringify(input.boundary);
  await checkBoundary(json);

  return prisma.$transaction(async (tx) => {
    const [before] = await tx.$queryRaw<CityRow[]>`
      SELECT ${cityColumns} FROM city WHERE slug = ${slug} FOR UPDATE
    `;
    await tx.$executeRaw`
      INSERT INTO city (slug, name, district_code, boundary, is_active, updated_at)
      VALUES (
        ${slug}, ${input.name}, ${input.districtCode},
        ST_Multi(ST_GeomFromGeoJSON(${json}))::geography,
        COALESCE(${input.isActive ?? null}::boolean, true), now()
      )
      ON CONFLICT (slug) DO UPDATE SET
        name = EXCLUDED.name,
        district_code = EXCLUDED.district_code,
        boundary = EXCLUDED.boundary,
        is_active = COALESCE(${input.isActive ?? null}::boolean, city.is_active),
        updated_at = now()
    `;
    const [after] = await tx.$queryRaw<CityRow[]>`
      SELECT ${cityColumns} FROM city WHERE slug = ${slug}
    `;
    const city = toCity(after);
    await writeAudit(tx, {
      actorAccountId: admin.accountId,
      action: "city.upsert",
      entityType: "city",
      entityId: slug,
      before: before ? cityAuditFields(toCity(before)) : null,
      after: cityAuditFields(city),
      ip: ip ?? null,
    });
    return city;
  });
}

export async function setCityActive(
  slug: string,
  isActive: boolean,
  admin: { accountId: string },
  ip: string | undefined,
): Promise<AdminCity> {
  return prisma.$transaction(async (tx) => {
    const [before] = await tx.$queryRaw<CityRow[]>`
      SELECT ${cityColumns} FROM city WHERE slug = ${slug} FOR UPDATE
    `;
    if (!before) throw notFound("City not found");
    await tx.$executeRaw`
      UPDATE city SET is_active = ${isActive}, updated_at = now() WHERE slug = ${slug}
    `;
    const [after] = await tx.$queryRaw<CityRow[]>`
      SELECT ${cityColumns} FROM city WHERE slug = ${slug}
    `;
    await writeAudit(tx, {
      actorAccountId: admin.accountId,
      action: "city.update",
      entityType: "city",
      entityId: slug,
      before: { isActive: before.isActive },
      after: { isActive },
      ip: ip ?? null,
    });
    return toCity(after);
  });
}
