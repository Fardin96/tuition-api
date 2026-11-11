import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../lib/prisma.js";

export type SaveLocationInput = {
  lat: number;
  lng: number;
  addressText: string;
  districtCode: string;
  placeId?: string;
};

export type OwnLocation = {
  lat: number | null;
  lng: number | null;
  addressText: string;
  districtCode: string;
  placeId: string | null;
  needsReaddress: boolean;
};

const LOCATION_TABLES = {
  tutor_location: { table: Prisma.sql`tutor_location`, owner: Prisma.sql`tutor_id` },
  student_location: { table: Prisma.sql`student_location`, owner: Prisma.sql`student_id` },
};

export async function upsertLocation(
  kind: keyof typeof LOCATION_TABLES,
  ownerId: string,
  input: SaveLocationInput,
  db: Prisma.TransactionClient = prisma,
) {
  const { table, owner } = LOCATION_TABLES[kind];
  const placed = input.placeId !== undefined;
  const source = placed ? Prisma.sql`'PLACES'` : Prisma.sql`'PIN'`;
  const fetchedAt = placed ? Prisma.sql`NOW()` : Prisma.sql`NULL`;
  await db.$executeRaw`
    INSERT INTO ${table} (id, ${owner}, place_id, address_text, district_code, geog, geog_fetched_at, needs_readdress, updated_at, geog_source)
    VALUES (
      gen_random_uuid(),
      ${ownerId},
      ${input.placeId ?? null},
      ${input.addressText},
      ${input.districtCode},
      ST_SetSRID(ST_MakePoint(${input.lng}, ${input.lat}), 4326)::geography,
      ${fetchedAt},
      false,
      NOW(),
      ${source}
    )
    ON CONFLICT (${owner}) DO UPDATE SET
      place_id = EXCLUDED.place_id,
      address_text = EXCLUDED.address_text,
      district_code = EXCLUDED.district_code,
      geog = EXCLUDED.geog,
      geog_fetched_at = EXCLUDED.geog_fetched_at,
      needs_readdress = false,
      geog_source = EXCLUDED.geog_source,
      updated_at = NOW();
  `;
}

export async function findOwnLocation(
  kind: keyof typeof LOCATION_TABLES,
  ownerId: string,
): Promise<OwnLocation | null> {
  const { table, owner } = LOCATION_TABLES[kind];
  const [row] = await prisma.$queryRaw<OwnLocation[]>`
    SELECT ST_Y(geog::geometry) AS lat, ST_X(geog::geometry) AS lng,
           address_text AS "addressText", district_code AS "districtCode",
           place_id AS "placeId", needs_readdress AS "needsReaddress"
    FROM ${table} WHERE ${owner} = ${ownerId}
  `;
  return row ?? null;
}

export async function getTutorNeedsReaddress(tutorId: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ needs_readdress: boolean }[]>`
    SELECT needs_readdress FROM tutor_location WHERE tutor_id = ${tutorId}
  `;
  return rows[0]?.needs_readdress ?? false;
}

export async function findNearbyTutors(accountId: string, radiusMeters: number) {
  const student = await prisma.student.findUnique({ where: { accountId } });
  if (!student) return [];

  const rows = await prisma.$queryRaw<
    {
      id: string;
      name: string;
      gender: string;
      rating_avg: unknown;
      rating_count: number;
      distance: number;
    }[]
  >`
    SELECT
      t.id,
      t.name,
      t.gender,
      t.rating_avg,
      t.rating_count,
      ST_Distance(tl.geog, sl.geog)::float8 AS distance
    FROM tutor_location tl
    JOIN tutor t ON t.id = tl.tutor_id
    CROSS JOIN student_location sl
    WHERE sl.student_id = ${student.id}
      AND sl.geog IS NOT NULL
      AND tl.district_code = sl.district_code
      AND tl.geog IS NOT NULL
      AND NOT tl.needs_readdress
      AND ST_DWithin(tl.geog, sl.geog, ${radiusMeters})
    ORDER BY distance;
  `;

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    gender: r.gender,
    ratingAvg: Number(r.rating_avg),
    ratingCount: r.rating_count,
    distanceMeters: Math.round(r.distance),
  }));
}

type ExpiryCounts = {
  softWarning: { tutorCount: number; studentCount: number };
  hardExpiry: { tutorCount: number; studentCount: number };
};

export async function runLocationExpiry(): Promise<ExpiryCounts> {
  const SOFT_DAYS = 21;
  const HARD_DAYS = 28;

  const [softTutor, softStudent, hardTutor, hardStudent] = await Promise.all([
    prisma.$executeRaw`
      UPDATE tutor_location
      SET needs_readdress = true, updated_at = NOW()
      WHERE NOT needs_readdress
        AND geog_source = 'PLACES'
        AND geog_fetched_at <= NOW() - make_interval(days => ${SOFT_DAYS});
    `,
    prisma.$executeRaw`
      UPDATE student_location
      SET needs_readdress = true, updated_at = NOW()
      WHERE NOT needs_readdress
        AND geog_source = 'PLACES'
        AND geog_fetched_at <= NOW() - make_interval(days => ${SOFT_DAYS});
    `,
    prisma.$executeRaw`
      UPDATE tutor_location
      SET geog = NULL, needs_readdress = true, updated_at = NOW()
      WHERE geog IS NOT NULL
        AND geog_source = 'PLACES'
        AND geog_fetched_at <= NOW() - make_interval(days => ${HARD_DAYS});
    `,
    prisma.$executeRaw`
      UPDATE student_location
      SET geog = NULL, needs_readdress = true, updated_at = NOW()
      WHERE geog IS NOT NULL
        AND geog_source = 'PLACES'
        AND geog_fetched_at <= NOW() - make_interval(days => ${HARD_DAYS});
    `,
  ]);

  return {
    softWarning: { tutorCount: Number(softTutor), studentCount: Number(softStudent) },
    hardExpiry: { tutorCount: Number(hardTutor), studentCount: Number(hardStudent) },
  };
}
