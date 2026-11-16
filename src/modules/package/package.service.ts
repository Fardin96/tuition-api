import { Prisma } from "../../generated/prisma/client.js";
import { ApplicationStatus } from "../../generated/prisma/enums.js";
import { type Cursor, decodeCursor, encodeCursor } from "../../lib/cursor.js";
import { appError, notFound } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import type { AuthContext } from "../auth/auth.schema.js";
import type { PackageBrowseQuery, PackagePageResponse, PackageResponse } from "./package.schema.js";

const DEFAULT_LIMIT = 20;
const CLOSING_STATUSES = [ApplicationStatus.CONFIRMED, ApplicationStatus.COMPLETED];

// Default-deny: only these tutor fields leave the API on a package.
const tutorCardSelect = {
  id: true,
  name: true,
  gender: true,
  ratingAvg: true,
  ratingCount: true,
  // Read for the student visibility check only; never serialized.
  isListed: true,
} as const;

type PackageRow = Prisma.TuitionPackageGetPayload<{
  include: { tutor: { select: typeof tutorCardSelect } };
}>;

function toPackageResponse(
  pkg: PackageRow,
  closed: boolean,
  myApplication: { id: string; status: ApplicationStatus } | null,
): PackageResponse {
  return {
    id: pkg.id,
    tutor: {
      id: pkg.tutor.id,
      name: pkg.tutor.name,
      gender: pkg.tutor.gender,
      ratingAvg: Number(pkg.tutor.ratingAvg),
      ratingCount: pkg.tutor.ratingCount,
    },
    subjectId: pkg.subjectId,
    areaId: pkg.areaId,
    curriculum: pkg.curriculum,
    levelCode: pkg.levelCode,
    academicGroup: pkg.academicGroup,
    admissionTargets: pkg.admissionTargets,
    isRetaker: pkg.isRetaker,
    levelNote: pkg.levelNote,
    timeOfDay: pkg.timeOfDay.toISOString().slice(11, 16),
    daysPerWeek: pkg.daysPerWeek,
    expectedSalary: pkg.expectedSalary,
    studentCount: pkg.studentCount,
    availableFrom: pkg.availableFrom.toISOString().slice(0, 10),
    status: pkg.status,
    moderationStatus: pkg.moderationStatus,
    createdAt: pkg.createdAt,
    closed,
    myApplication,
  };
}

// Browse filters as Prisma.sql fragments. The nearby clause depends on whether the student has a usable pin.
function browseFilters(query: PackageBrowseQuery, nearby: Prisma.Sql, cursor: Cursor | null) {
  return {
    nearby,
    curriculum: query.curriculum
      ? Prisma.sql`AND p.curriculum::text = ${query.curriculum}`
      : Prisma.empty,
    levelCode:
      query.levelCode !== undefined
        ? Prisma.sql`AND p.level_code = ${query.levelCode}`
        : Prisma.empty,
    subjectId: query.subjectId ? Prisma.sql`AND p.subject_id = ${query.subjectId}` : Prisma.empty,
    keyset: cursor
      ? Prisma.sql`AND (p.created_at, p.id) < (${cursor.createdAt}, ${cursor.id}::uuid)`
      : Prisma.empty,
  };
}

export async function browsePackages(
  accountId: string,
  query: PackageBrowseQuery,
): Promise<PackagePageResponse> {
  const student = await prisma.student.findUnique({
    where: { accountId },
    select: { id: true, areaId: true },
  });
  if (!student) throw notFound("Student profile not found");

  const pinRows = await prisma.$queryRaw<{ usable: boolean }[]>`
    SELECT (geog IS NOT NULL AND NOT needs_readdress) AS usable
    FROM student_location
    WHERE student_id = ${student.id}::uuid
  `;
  const hasPin = pinRows[0]?.usable === true;
  const locationMissing = query.scope === "nearby" && !hasPin;

  // Pin path: online packages, or packages whose tutor has a zone covering the student pin.
  // No-pin path: online packages, or packages in the student's own area.
  let nearby = Prisma.empty;
  if (query.scope === "nearby") {
    nearby = hasPin
      ? Prisma.sql`AND (p.area_id IS NULL OR (sl.geog IS NOT NULL AND NOT sl.needs_readdress AND EXISTS (
            SELECT 1 FROM tutor_zone z
            WHERE z.tutor_id = p.tutor_id
              AND ST_DWithin(sl.geog, z.center, z.radius_m))))`
      : Prisma.sql`AND (p.area_id IS NULL OR p.area_id = ${student.areaId})`;
  }

  const limit = query.limit ?? DEFAULT_LIMIT;
  const f = browseFilters(query, nearby, query.cursor ? decodeCursor(query.cursor) : null);

  const rows = await prisma.$queryRaw<{ id: string; createdAt: Date }[]>`
    SELECT p.id, p.created_at AS "createdAt"
    FROM tuition_package p
    JOIN tutor t ON t.id = p.tutor_id
    LEFT JOIN student_location sl ON sl.student_id = ${student.id}::uuid
    WHERE p.status::text = 'OPEN'
      AND p.moderation_status::text = 'APPROVED'
      AND t.is_listed
      ${f.nearby}
      ${f.curriculum}
      ${f.levelCode}
      ${f.subjectId}
      ${f.keyset}
    ORDER BY p.created_at DESC, p.id DESC
    LIMIT ${limit + 1}
  `;

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const ids = page.map((r) => r.id);

  const [packages, closedRows, myRows] = await Promise.all([
    ids.length
      ? prisma.tuitionPackage.findMany({
          where: { id: { in: ids } },
          include: { tutor: { select: tutorCardSelect } },
        })
      : Promise.resolve([] as PackageRow[]),
    ids.length
      ? prisma.application.findMany({
          where: { packageId: { in: ids }, status: { in: CLOSING_STATUSES } },
          distinct: ["packageId"],
          select: { packageId: true },
        })
      : Promise.resolve([]),
    ids.length
      ? prisma.application.findMany({
          where: { packageId: { in: ids }, studentId: student.id },
          select: { id: true, packageId: true, status: true },
        })
      : Promise.resolve([]),
  ]);

  const packageById = new Map(packages.map((p) => [p.id, p]));
  const closedIds = new Set(closedRows.map((r) => r.packageId));
  const myByPackage = new Map(myRows.map((r) => [r.packageId, { id: r.id, status: r.status }]));

  // Keep the SQL order (created_at DESC, id DESC).
  const result: PackageResponse[] = [];
  for (const row of page) {
    const pkg = packageById.get(row.id);
    if (!pkg) continue;
    result.push(toPackageResponse(pkg, closedIds.has(pkg.id), myByPackage.get(pkg.id) ?? null));
  }

  return {
    packages: result,
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
    locationMissing,
  };
}

// Detail visibility: STUDENT sees APPROVED packages only, TUTOR only its own, ADMIN (ACTIVE admin_user) any.
export async function getPackageForCaller(
  id: string,
  account: AuthContext,
): Promise<PackageResponse> {
  let studentId: string | null = null;

  if (account.role === "STUDENT") {
    const student = await prisma.student.findUnique({
      where: { accountId: account.accountId },
      select: { id: true },
    });
    if (!student) throw notFound("Student profile not found");
    studentId = student.id;
  } else if (account.role === "ADMIN") {
    const admin = await prisma.adminUser.findUnique({
      where: { accountId: account.accountId },
      select: { status: true },
    });
    if (admin?.status !== "ACTIVE") throw appError("Forbidden", 403, "Forbidden");
  }

  const pkg = await prisma.tuitionPackage.findUnique({
    where: { id },
    include: { tutor: { select: tutorCardSelect } },
  });
  if (!pkg) throw notFound("Package not found");

  // Same visibility as browse: approved package, and the tutor must be listed.
  if (
    account.role === "STUDENT" &&
    (pkg.moderationStatus !== "APPROVED" || pkg.tutor.isListed !== true)
  ) {
    throw notFound("Package not found");
  }
  if (account.role === "TUTOR") {
    const tutor = await prisma.tutor.findUnique({
      where: { accountId: account.accountId },
      select: { id: true },
    });
    if (!tutor || tutor.id !== pkg.tutorId) throw notFound("Package not found");
  }

  const [closedRow, myApplication] = await Promise.all([
    prisma.application.findFirst({
      where: { packageId: id, status: { in: CLOSING_STATUSES } },
      select: { id: true },
    }),
    studentId
      ? prisma.application.findFirst({
          where: { packageId: id, studentId },
          select: { id: true, status: true },
        })
      : Promise.resolve(null),
  ]);

  return toPackageResponse(pkg, closedRow !== null, myApplication);
}
