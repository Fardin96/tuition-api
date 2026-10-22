import { prisma } from "../../lib/prisma.js";

export type SaveLocationInput = {
  placeId: string;
  addressText: string;
  districtCode: string;
  latitude: number;
  longitude: number;
};

export async function upsertTutorLocation(tutorId: string, input: SaveLocationInput) {
  await prisma.$executeRaw`
    INSERT INTO tutor_location (id, tutor_id, place_id, address_text, district_code, geog, geog_fetched_at, needs_readdress, updated_at)
    VALUES (
      gen_random_uuid(),
      ${tutorId},
      ${input.placeId},
      ${input.addressText},
      ${input.districtCode},
      ST_SetSRID(ST_MakePoint(${input.longitude}, ${input.latitude}), 4326)::geography,
      NOW(),
      false,
      NOW()
    )
    ON CONFLICT (tutor_id) DO UPDATE SET
      place_id = EXCLUDED.place_id,
      address_text = EXCLUDED.address_text,
      district_code = EXCLUDED.district_code,
      geog = EXCLUDED.geog,
      geog_fetched_at = NOW(),
      needs_readdress = false,
      updated_at = NOW();
  `;
}

export async function upsertStudentLocation(studentId: string, input: SaveLocationInput) {
  await prisma.$executeRaw`
    INSERT INTO student_location (id, student_id, place_id, address_text, district_code, geog, geog_fetched_at, needs_readdress, updated_at)
    VALUES (
      gen_random_uuid(),
      ${studentId},
      ${input.placeId},
      ${input.addressText},
      ${input.districtCode},
      ST_SetSRID(ST_MakePoint(${input.longitude}, ${input.latitude}), 4326)::geography,
      NOW(),
      false,
      NOW()
    )
    ON CONFLICT (student_id) DO UPDATE SET
      place_id = EXCLUDED.place_id,
      address_text = EXCLUDED.address_text,
      district_code = EXCLUDED.district_code,
      geog = EXCLUDED.geog,
      geog_fetched_at = NOW(),
      needs_readdress = false,
      updated_at = NOW();
  `;
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
        AND geog_fetched_at <= NOW() - make_interval(days => ${SOFT_DAYS});
    `,
    prisma.$executeRaw`
      UPDATE student_location
      SET needs_readdress = true, updated_at = NOW()
      WHERE NOT needs_readdress
        AND geog_fetched_at <= NOW() - make_interval(days => ${SOFT_DAYS});
    `,
    prisma.$executeRaw`
      UPDATE tutor_location
      SET geog = NULL, needs_readdress = true, updated_at = NOW()
      WHERE geog IS NOT NULL
        AND geog_fetched_at <= NOW() - make_interval(days => ${HARD_DAYS});
    `,
    prisma.$executeRaw`
      UPDATE student_location
      SET geog = NULL, needs_readdress = true, updated_at = NOW()
      WHERE geog IS NOT NULL
        AND geog_fetched_at <= NOW() - make_interval(days => ${HARD_DAYS});
    `,
  ]);

  return {
    softWarning: { tutorCount: Number(softTutor), studentCount: Number(softStudent) },
    hardExpiry: { tutorCount: Number(hardTutor), studentCount: Number(hardStudent) },
  };
}
