import { Prisma } from "../../generated/prisma/client.js";
import { decodeCursor, encodeCursor } from "../../lib/cursor.js";
import { appError, notFound } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import type {
  CreateZoneInput,
  CreateZoneLimitRequestInput,
  UpdateZoneInput,
  ZoneLimitRequestListQuery,
  ZoneLimitRequestResponse,
  ZoneResponse,
} from "./zone.schema.js";

const ZONE_REQUEST_WINDOW_MS = 24 * 60 * 60 * 1000;
const ZONE_REQUESTS_PER_WINDOW = 3;

type Db = Prisma.TransactionClient;

type ZoneRow = {
  id: string;
  label: string;
  lat: number;
  lng: number;
  radiusM: number;
  placeId: string | null;
  addressText: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type LinkRow = { zoneId: string; requirementId: string };
type PackageLinkRow = { zoneId: string; packageId: string };

type LimitRequestRow = {
  id: string;
  requestedLimit: number;
  reason: string;
  status: "PENDING" | "APPROVED" | "DENIED";
  decisionNote: string | null;
  decidedAt: Date | null;
  createdAt: Date;
};

function toLimitRequest(row: LimitRequestRow): ZoneLimitRequestResponse {
  return {
    id: row.id,
    requestedLimit: row.requestedLimit,
    reason: row.reason,
    status: row.status,
    decisionNote: row.decisionNote,
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

async function findTutor(accountId: string) {
  return prisma.tutor.findUnique({
    where: { accountId },
    select: { id: true, zoneLimit: true },
  });
}

// Loads zones for one tutor (optionally one zone) with their requirement and OPEN package links,
// ordered created_at, id.
async function loadZones(db: Db, tutorId: string, zoneId?: string): Promise<ZoneResponse[]> {
  const onlyZone = zoneId ? Prisma.sql`AND z.id = ${zoneId}::uuid` : Prisma.empty;
  const rows = await db.$queryRaw<ZoneRow[]>`
    SELECT z.id, z.label,
           ST_Y(z.center::geometry)::float8 AS lat,
           ST_X(z.center::geometry)::float8 AS lng,
           z.radius_m AS "radiusM", z.place_id AS "placeId", z.address_text AS "addressText",
           z.created_at AS "createdAt", z.updated_at AS "updatedAt"
    FROM tutor_zone z
    WHERE z.tutor_id = ${tutorId}::uuid ${onlyZone}
    ORDER BY z.created_at ASC, z.id ASC
  `;
  if (rows.length === 0) return [];

  const links = await db.$queryRaw<LinkRow[]>`
    SELECT zone_id AS "zoneId", requirement_id AS "requirementId"
    FROM tutor_requirement_zone
    WHERE tutor_id = ${tutorId}::uuid
    ORDER BY requirement_id ASC
  `;
  const packageLinks = await db.$queryRaw<PackageLinkRow[]>`
    SELECT pz.zone_id AS "zoneId", pz.package_id AS "packageId"
    FROM package_zone pz
    JOIN tuition_package p ON p.id = pz.package_id
    WHERE pz.tutor_id = ${tutorId}::uuid AND p.status = 'OPEN'
    ORDER BY pz.package_id ASC
  `;
  const byZone = new Map<string, string[]>();
  for (const link of links) {
    const list = byZone.get(link.zoneId) ?? [];
    list.push(link.requirementId);
    byZone.set(link.zoneId, list);
  }
  const packagesByZone = new Map<string, string[]>();
  for (const link of packageLinks) {
    const list = packagesByZone.get(link.zoneId) ?? [];
    list.push(link.packageId);
    packagesByZone.set(link.zoneId, list);
  }

  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    lat: Number(row.lat),
    lng: Number(row.lng),
    radiusM: Number(row.radiusM),
    placeId: row.placeId,
    addressText: row.addressText,
    requirementIds: byZone.get(row.id) ?? [],
    packageIds: packagesByZone.get(row.id) ?? [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

async function findPendingRequest(db: Db, tutorId: string) {
  const row = await db.zoneLimitRequest.findFirst({
    where: { tutorId, status: "PENDING" },
  });
  return row ? toLimitRequest(row) : null;
}

export async function listZones(accountId: string) {
  const tutor = await findTutor(accountId);
  if (!tutor) return null;

  const [zones, pendingRequest] = await Promise.all([
    loadZones(prisma, tutor.id),
    findPendingRequest(prisma, tutor.id),
  ]);
  return { zones, limit: tutor.zoneLimit, used: zones.length, pendingRequest };
}

// Raised by the tutor_zone_quota_trg BEFORE INSERT trigger when the tutor is at zone_limit.
function isZoneLimitError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  let serialized = "";
  try {
    serialized = JSON.stringify(error) ?? "";
  } catch {
    serialized = "";
  }
  return message.includes("zone limit reached") || serialized.includes("zone limit reached");
}

export async function createZone(accountId: string, input: CreateZoneInput) {
  const tutor = await findTutor(accountId);
  if (!tutor) return null;

  let zoneId: string;
  try {
    const [row] = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO tutor_zone (id, tutor_id, label, center, radius_m, place_id, address_text, geog_source, updated_at)
      VALUES (
        gen_random_uuid(),
        ${tutor.id}::uuid,
        ${input.label},
        ST_SetSRID(ST_MakePoint(${input.lng}, ${input.lat}), 4326)::geography,
        ${input.radiusM},
        ${input.placeId ?? null},
        ${input.addressText ?? null},
        'PIN'::"GeogSource",
        NOW()
      )
      RETURNING id
    `;
    zoneId = row.id;
  } catch (error) {
    if (isZoneLimitError(error)) {
      throw appError("ZoneLimitReached", 409, `You can have at most ${tutor.zoneLimit} zones`);
    }
    throw error;
  }

  const [zone] = await loadZones(prisma, tutor.id, zoneId);
  return zone;
}

export async function updateZone(accountId: string, zoneId: string, input: UpdateZoneInput) {
  const tutor = await findTutor(accountId);
  if (!tutor) return null;

  const sets: Prisma.Sql[] = [];
  if (input.label !== undefined) sets.push(Prisma.sql`label = ${input.label}`);
  if (input.lat !== undefined && input.lng !== undefined) {
    sets.push(
      Prisma.sql`center = ST_SetSRID(ST_MakePoint(${input.lng}, ${input.lat}), 4326)::geography`,
    );
  }
  if (input.radiusM !== undefined) sets.push(Prisma.sql`radius_m = ${input.radiusM}`);
  if (input.placeId !== undefined) sets.push(Prisma.sql`place_id = ${input.placeId}`);
  if (input.addressText !== undefined) {
    sets.push(Prisma.sql`address_text = ${input.addressText}`);
  }
  sets.push(Prisma.sql`updated_at = NOW()`);

  const updated = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE tutor_zone
    SET ${Prisma.join(sets, ", ")}
    WHERE id = ${zoneId}::uuid AND tutor_id = ${tutor.id}::uuid
    RETURNING id
  `;
  if (updated.length === 0) throw notFound("Zone not found");

  const [zone] = await loadZones(prisma, tutor.id, zoneId);
  return zone;
}

export async function deleteZone(accountId: string, zoneId: string) {
  const tutor = await findTutor(accountId);
  if (!tutor) return null;

  return prisma.$transaction(async (tx) => {
    const [zone] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM tutor_zone WHERE id = ${zoneId}::uuid AND tutor_id = ${tutor.id}::uuid
    `;
    if (!zone) throw notFound("Zone not found");

    const affected = await tx.$queryRaw<
      {
        id: string;
        name: string;
        isDefault: boolean;
        isActive: boolean;
        teachesOnline: boolean;
      }[]
    >`
      SELECT r.id, r.name, r.is_default AS "isDefault", r.is_active AS "isActive",
             r.teaches_online AS "teachesOnline"
      FROM tutor_requirement_zone trz
      JOIN tutor_requirement r ON r.id = trz.requirement_id
      WHERE trz.zone_id = ${zoneId}::uuid
    `;

    // Read before the delete: the package links go with the zone.
    const affectedPackages = await tx.$queryRaw<
      { id: string; title: string; teachesOnline: boolean }[]
    >`
      SELECT p.id, p.title, p.teaches_online AS "teachesOnline"
      FROM package_zone pz
      JOIN tuition_package p ON p.id = pz.package_id
      WHERE pz.zone_id = ${zoneId}::uuid AND p.status = 'OPEN'
      ORDER BY p.id ASC
    `;

    // Links are removed by ON DELETE CASCADE from tutor_zone.
    await tx.$executeRaw`
      DELETE FROM tutor_zone WHERE id = ${zoneId}::uuid AND tutor_id = ${tutor.id}::uuid
    `;

    const affectedRequirements: Array<(typeof affected)[number] & { remainingZoneCount: number }> =
      [];
    for (const requirement of affected) {
      const [{ count }] = await tx.$queryRaw<{ count: number }[]>`
        SELECT count(*)::int AS count FROM tutor_requirement_zone
        WHERE requirement_id = ${requirement.id}::uuid
      `;
      affectedRequirements.push({ ...requirement, remainingZoneCount: count });
    }

    const affectedPackageRows: Array<
      (typeof affectedPackages)[number] & { remainingZoneCount: number }
    > = [];
    for (const pkg of affectedPackages) {
      const [{ count }] = await tx.$queryRaw<{ count: number }[]>`
        SELECT count(*)::int AS count FROM package_zone
        WHERE package_id = ${pkg.id}::uuid
      `;
      affectedPackageRows.push({ ...pkg, remainingZoneCount: count });
    }

    return { id: zoneId, affectedRequirements, affectedPackages: affectedPackageRows };
  });
}

export async function createZoneLimitRequest(
  accountId: string,
  input: CreateZoneLimitRequestInput,
) {
  const tutor = await findTutor(accountId);
  if (!tutor) return null;

  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM tutor WHERE id = ${tutor.id}::uuid FOR UPDATE`;
      const current = await tx.tutor.findUniqueOrThrow({
        where: { id: tutor.id },
        select: { zoneLimit: true },
      });

      const pending = await tx.zoneLimitRequest.findFirst({
        where: { tutorId: tutor.id, status: "PENDING" },
        select: { id: true },
      });
      if (pending) {
        throw appError("ZoneRequestPending", 409, "You already have a pending request");
      }

      if (input.requestedLimit <= current.zoneLimit) {
        throw appError(
          "ValidationError",
          400,
          `Ask for more than your current limit of ${current.zoneLimit} zones`,
        );
      }

      const recent = await tx.zoneLimitRequest.count({
        where: {
          tutorId: tutor.id,
          createdAt: { gte: new Date(Date.now() - ZONE_REQUEST_WINDOW_MS) },
        },
      });
      if (recent >= ZONE_REQUESTS_PER_WINDOW) {
        throw appError("RateLimited", 429, "Daily limit reached. Try again tomorrow.");
      }

      const created = await tx.zoneLimitRequest.create({
        data: {
          tutorId: tutor.id,
          requestedLimit: input.requestedLimit,
          reason: input.reason,
        },
      });
      return toLimitRequest(created);
    });
  } catch (error) {
    // Race fallback: the partial unique index zlr_one_pending_per_tutor fired.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw appError("ZoneRequestPending", 409, "You already have a pending request");
    }
    throw error;
  }
}

export async function listZoneLimitRequests(accountId: string, query: ZoneLimitRequestListQuery) {
  const tutor = await findTutor(accountId);
  if (!tutor) return null;

  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  const rows = await prisma.zoneLimitRequest.findMany({
    where: {
      tutorId: tutor.id,
      ...(cursor
        ? {
            OR: [
              { createdAt: { lt: cursor.createdAt } },
              { createdAt: cursor.createdAt, id: { lt: cursor.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: query.limit + 1,
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];
  return {
    requests: page.map(toLimitRequest),
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
  };
}
