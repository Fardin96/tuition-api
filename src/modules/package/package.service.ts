import { Prisma } from "../../generated/prisma/client.js";
import {
  ApplicationStatus,
  type AppNotificationKind,
  type ListingStatus,
} from "../../generated/prisma/enums.js";
import { avatarSelect, avatarUrlFor } from "../../lib/avatar.js";
import { type Cursor, decodeCursor, encodeCursor } from "../../lib/cursor.js";
import { appError, notFound, validationIssuesError } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import type { AuthContext } from "../auth/auth.schema.js";
import { prepareSetSubjects } from "../tutor/tutor.service.js";
import {
  type CreatePackageInput,
  type MyPackageListResponse,
  type PackageBrowseQuery,
  type PackagePageResponse,
  type PackageResponse,
  type PackageRules,
  packageRuleIssues,
  type UpdatePackageInput,
} from "./package.schema.js";

type Db = Prisma.TransactionClient;

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
  // Only for avatarUrl: the account itself never leaves the API.
  account: { select: avatarSelect },
} as const;

// Zones are read for the count and for the tutor's own list. Students only ever see zoneCount.
export const packageInclude = {
  tutor: { select: tutorCardSelect },
  subjects: { select: { subjectId: true }, orderBy: { subjectId: "asc" } },
  zones: { select: { zoneId: true }, orderBy: { zoneId: "asc" } },
} as const;

export type PackageRow = Prisma.TuitionPackageGetPayload<{ include: typeof packageInclude }>;

// Times are Time columns and the day is a Date. Only the HH:MM and YYYY-MM-DD parts matter.
const clockOf = (d: Date) => d.toISOString().slice(11, 16);
const dayOf = (d: Date) => d.toISOString().slice(0, 10);
const toClock = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00Z`);
const toDay = (ymd: string) => new Date(`${ymd}T00:00:00Z`);

export async function toPackageResponse(
  pkg: PackageRow,
  closed: boolean,
  myApplication: { id: string; status: ApplicationStatus } | null,
): Promise<PackageResponse> {
  return {
    id: pkg.id,
    tutor: {
      id: pkg.tutor.id,
      name: pkg.tutor.name,
      gender: pkg.tutor.gender,
      ratingAvg: Number(pkg.tutor.ratingAvg),
      ratingCount: pkg.tutor.ratingCount,
      avatarUrl: await avatarUrlFor(pkg.tutor.account),
    },
    title: pkg.title,
    description: pkg.description,
    coverage: pkg.coverage,
    durationWeeks: pkg.durationWeeks,
    price: pkg.price,
    subjectIds: pkg.subjects.map((row) => row.subjectId),
    levelMin: pkg.levelMin,
    levelMax: pkg.levelMax,
    curricula: pkg.curricula,
    academicGroups: pkg.academicGroups,
    admissionTargets: pkg.admissionTargets,
    timeFrom: clockOf(pkg.timeFrom),
    timeTo: clockOf(pkg.timeTo),
    availableDays: pkg.availableDays,
    daysPerWeek: pkg.daysPerWeek,
    maxStudents: pkg.maxStudents,
    availableFrom: dayOf(pkg.availableFrom),
    teachesOnline: pkg.teachesOnline,
    zoneCount: pkg.zones.length,
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
      ? Prisma.sql`AND ${query.curriculum}::"Curriculum" = ANY(p.curricula)`
      : Prisma.empty,
    levelCode:
      query.levelCode !== undefined
        ? Prisma.sql`AND ${query.levelCode} BETWEEN p.level_min AND p.level_max`
        : Prisma.empty,
    subjectId: query.subjectId
      ? Prisma.sql`AND EXISTS (
          SELECT 1 FROM package_subject ps
          WHERE ps.package_id = p.id AND ps.subject_id = ${query.subjectId})`
      : Prisma.empty,
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
    select: { id: true },
  });
  if (!student) throw notFound("Student profile not found");

  const pinRows = await prisma.$queryRaw<{ usable: boolean }[]>`
    SELECT (geog IS NOT NULL AND NOT needs_readdress) AS usable
    FROM student_location
    WHERE student_id = ${student.id}::uuid
  `;
  const hasPin = pinRows[0]?.usable === true;
  const locationMissing = query.scope === "nearby" && !hasPin;

  // Pin path: online packages, or packages with one of their own zones covering the student pin.
  // No-pin path: online packages only. The package's zones are its own, not every zone of the tutor.
  let nearby = Prisma.empty;
  if (query.scope === "nearby") {
    nearby = hasPin
      ? Prisma.sql`AND (p.teaches_online OR EXISTS (
            SELECT 1 FROM package_zone pz
            JOIN tutor_zone z ON z.id = pz.zone_id
            WHERE pz.package_id = p.id
              AND ST_DWithin(sl.geog, z.center, z.radius_m)))`
      : Prisma.sql`AND p.teaches_online`;
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
          include: packageInclude,
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
    result.push(
      await toPackageResponse(pkg, closedIds.has(pkg.id), myByPackage.get(pkg.id) ?? null),
    );
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
    include: packageInclude,
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

async function findTutorId(accountId: string): Promise<string> {
  const tutor = await prisma.tutor.findUnique({ where: { accountId }, select: { id: true } });
  if (!tutor) throw notFound("Tutor profile not found");
  return tutor.id;
}

// Same lock as the requirement sets take before they change subjects.
async function lockTutorRow(db: Db, tutorId: string) {
  await db.$queryRaw`SELECT id FROM tutor WHERE id = ${tutorId}::uuid FOR UPDATE`;
}

// Every subject must be on the tutor's profile and every zone must be one of the tutor's own.
// Lists are already checked for duplicates by zod.
async function assertPackageRefs(
  db: Db,
  tutorId: string,
  refs: { subjectIds?: number[]; zoneIds?: string[] },
) {
  if (refs.subjectIds) {
    const owned = await db.tutorSubject.findMany({
      where: { tutorId, subjectId: { in: refs.subjectIds } },
      select: { subjectId: true },
    });
    if (owned.length !== refs.subjectIds.length) {
      throw appError("InvalidRequirement", 400, "Pick subjects from your profile", {
        fields: ["subjectIds"],
      });
    }
  }
  if (refs.zoneIds) {
    const owned = await db.tutorZone.findMany({
      where: { tutorId, id: { in: refs.zoneIds } },
      select: { id: true },
    });
    if (owned.length !== refs.zoneIds.length) {
      throw appError("InvalidRequirement", 400, "Pick zones from your teaching zones", {
        fields: ["zoneIds"],
      });
    }
  }
}

// Locks the package row for the rest of the transaction. Missing and foreign packages both give 404.
async function lockOwnedPackage(db: Db, id: string, tutorId: string): Promise<ListingStatus> {
  const [row] = await db.$queryRaw<{ tutorId: string; status: ListingStatus }[]>`
    SELECT tutor_id AS "tutorId", status FROM tuition_package WHERE id = ${id}::uuid FOR UPDATE
  `;
  if (!row || row.tutorId !== tutorId) throw notFound("Package not found");
  return row.status;
}

// One in-app alert per application. Written in the same transaction as the package change.
async function alertStudents(
  db: Db,
  applications: { id: string; student: { accountId: string } }[],
  kind: AppNotificationKind,
) {
  if (applications.length === 0) return;
  await db.appNotification.createMany({
    data: applications.map((a) => ({
      recipientId: a.student.accountId,
      kind,
      applicationId: a.id,
    })),
  });
}

// Readiness comes from SQL tutor_missing_requirements(); never duplicate those checks here.
// A package carries its own subjects and zones, so the default requirement set does not count.
async function assertPackageReadiness(
  db: Prisma.TransactionClient | typeof prisma,
  tutorId: string,
  message: string,
) {
  const [readiness] = await db.$queryRaw<{ missing: string[] }[]>`
    SELECT tutor_missing_requirements(${tutorId}::uuid) AS missing
  `;
  const missing = (readiness?.missing ?? []).filter((key) => key !== "default_requirement");
  if (missing.length > 0) {
    throw appError("ProfileIncomplete", 403, message, { missing });
  }
}

export async function createPackage(
  account: AuthContext,
  input: CreatePackageInput,
): Promise<PackageResponse> {
  const tutorId = await findTutorId(account.accountId);

  await assertPackageReadiness(prisma, tutorId, "Complete your profile before creating a package");

  const { subjectIds, zoneIds, syncProfileSubjects, timeFrom, timeTo, availableFrom, ...values } =
    input;

  const pkg = await prisma.$transaction(async (tx) => {
    await lockTutorRow(tx, tutorId);
    await prepareSetSubjects(tx, tutorId, subjectIds, syncProfileSubjects === true);
    await assertPackageRefs(tx, tutorId, { subjectIds, zoneIds });

    return tx.tuitionPackage.create({
      data: {
        ...values,
        tutorId,
        timeFrom: toClock(timeFrom),
        timeTo: toClock(timeTo),
        availableFrom: toDay(availableFrom),
        status: "OPEN",
        // Students see a package only after an admin approves it (POST /admin/packages/:id/moderate).
        moderationStatus: "PENDING",
        subjects: { create: subjectIds.map((subjectId) => ({ subjectId })) },
        zones: { create: zoneIds.map((zoneId) => ({ zoneId })) },
      },
      include: packageInclude,
    });
  });
  return toPackageResponse(pkg, false, null);
}

export async function listMyPackages(account: AuthContext): Promise<MyPackageListResponse> {
  const tutorId = await findTutorId(account.accountId);

  const packages = await prisma.tuitionPackage.findMany({
    where: { tutorId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 100,
    include: packageInclude,
  });

  // One grouped count for the whole list, instead of a query per package.
  const counts = await prisma.application.groupBy({
    by: ["packageId", "status"],
    where: { packageId: { in: packages.map((p) => p.id) } },
    _count: { _all: true },
  });

  const tally = new Map<
    string,
    { requestCount: number; pendingRequestCount: number; closed: boolean }
  >();
  for (const row of counts) {
    if (!row.packageId) continue;
    const t = tally.get(row.packageId) ?? {
      requestCount: 0,
      pendingRequestCount: 0,
      closed: false,
    };
    t.requestCount += row._count._all;
    if (row.status === "PENDING") t.pendingRequestCount += row._count._all;
    if (CLOSING_STATUSES.some((s) => s === row.status)) t.closed = true;
    tally.set(row.packageId, t);
  }

  return {
    packages: await Promise.all(
      packages.map(async (pkg) => {
        const t = tally.get(pkg.id);
        return {
          ...(await toPackageResponse(pkg, t?.closed ?? false, null)),
          zoneIds: pkg.zones.map((row) => row.zoneId),
          moderationNote: pkg.moderationNote,
          updatedAt: pkg.updatedAt,
          pendingRequestCount: t?.pendingRequestCount ?? 0,
          requestCount: t?.requestCount ?? 0,
        };
      }),
    ),
  };
}

export async function updatePackage(
  account: AuthContext,
  id: string,
  input: UpdatePackageInput,
): Promise<PackageResponse> {
  const tutorId = await findTutorId(account.accountId);
  const { subjectIds, zoneIds, syncProfileSubjects, timeFrom, timeTo, availableFrom, ...values } =
    input;

  await prisma.$transaction(async (tx) => {
    // Tutor row first, then the package, so this never waits on a subject change in the other order.
    await lockTutorRow(tx, tutorId);
    const status = await lockOwnedPackage(tx, id, tutorId);
    if (status !== "OPEN") {
      throw appError("ListingNotOpen", 409, "Only open packages can be edited");
    }

    const existing = await tx.tuitionPackage.findUniqueOrThrow({
      where: { id },
      include: packageInclude,
    });

    // The shared rules run on the merged values. An absent key keeps the stored value; null daysPerWeek clears it.
    const merged: PackageRules = {
      levelMin: values.levelMin ?? existing.levelMin,
      levelMax: values.levelMax ?? existing.levelMax,
      curricula: values.curricula ?? existing.curricula,
      academicGroups: values.academicGroups ?? existing.academicGroups,
      admissionTargets: values.admissionTargets ?? existing.admissionTargets,
      timeFrom: timeFrom ?? clockOf(existing.timeFrom),
      timeTo: timeTo ?? clockOf(existing.timeTo),
      availableDays: values.availableDays ?? existing.availableDays,
      daysPerWeek: values.daysPerWeek !== undefined ? values.daysPerWeek : existing.daysPerWeek,
      teachesOnline: values.teachesOnline ?? existing.teachesOnline,
      zoneIds: zoneIds ?? existing.zones.map((row) => row.zoneId),
    };
    const issues = packageRuleIssues(merged);
    if (issues.length > 0) throw validationIssuesError("Invalid package", issues);

    // Editing a rejected package resubmits it, so it needs the same readiness as a new one.
    if (existing.moderationStatus === "REJECTED") {
      await assertPackageReadiness(
        tx,
        tutorId,
        "Complete your profile before resubmitting a package",
      );
    }

    if (subjectIds !== undefined) {
      await prepareSetSubjects(tx, tutorId, subjectIds, syncProfileSubjects === true);
    }
    await assertPackageRefs(tx, tutorId, { subjectIds, zoneIds });

    if (subjectIds !== undefined) {
      await tx.packageSubject.deleteMany({ where: { packageId: id } });
      await tx.packageSubject.createMany({
        data: subjectIds.map((subjectId) => ({ packageId: id, tutorId, subjectId })),
      });
    }
    if (zoneIds !== undefined) {
      await tx.packageZone.deleteMany({ where: { packageId: id } });
      await tx.packageZone.createMany({
        data: zoneIds.map((zoneId) => ({ packageId: id, tutorId, zoneId })),
      });
    }

    // Edits to an approved package stay live (admin notice and revert are planned, endpoints.md #55).
    // Editing a rejected package resubmits it for review.
    const resubmit = existing.moderationStatus === "REJECTED";
    await tx.tuitionPackage.update({
      where: { id },
      data: {
        ...values,
        ...(resubmit && { moderationStatus: "PENDING", moderationNote: null }),
        ...(timeFrom !== undefined && { timeFrom: toClock(timeFrom) }),
        ...(timeTo !== undefined && { timeTo: toClock(timeTo) }),
        ...(availableFrom !== undefined && { availableFrom: toDay(availableFrom) }),
      },
    });

    const applications = await tx.application.findMany({
      where: { packageId: id, status: { in: ["PENDING", "CONFIRMED"] } },
      select: { id: true, student: { select: { accountId: true } } },
    });
    await alertStudents(tx, applications, "PACKAGE_UPDATED");
  });

  return getPackageForCaller(id, account);
}

export async function closePackage(account: AuthContext, id: string): Promise<PackageResponse> {
  const tutorId = await findTutorId(account.accountId);

  await prisma.$transaction(async (tx) => {
    const status = await lockOwnedPackage(tx, id, tutorId);
    if (status !== "OPEN") {
      throw appError("ListingNotOpen", 409, "This package is already closed");
    }
    await tx.tuitionPackage.update({ where: { id }, data: { status: "CLOSED" } });

    // Confirmed placements are not touched. Only requests still waiting for the tutor expire.
    const pending = await tx.application.findMany({
      where: { packageId: id, status: "PENDING" },
      select: { id: true, student: { select: { accountId: true } } },
    });
    if (pending.length > 0) {
      await tx.application.updateMany({
        where: { id: { in: pending.map((a) => a.id) } },
        data: { status: "EXPIRED" },
      });
    }
    await alertStudents(tx, pending, "PACKAGE_CLOSED");
  });

  return getPackageForCaller(id, account);
}
