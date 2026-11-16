import type { Prisma } from "../../generated/prisma/client.js";
import type {
  ApplicationStatus,
  InitiatedBy,
  ListingStatus,
  ModerationStatus,
} from "../../generated/prisma/enums.js";
import { decodeCursor, encodeCursor } from "../../lib/cursor.js";
import { notFound } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import type { AuthContext } from "../auth/auth.schema.js";
import { setMatchesRequirementSql } from "../requirement/set-match.js";
import {
  type ApplicationAction,
  type ApplicationDetailResponse,
  type ApplicationListQuery,
  type ApplicationPageResponse,
  type ApplicationResponse,
  type ApplicationTutorProfile,
  type ApplicationTutorSet,
  FEE_UNPAID_AFTER_DAYS,
} from "./application.schema.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export type Side = "TUTOR" | "STUDENT";

export type TargetState = {
  status: ListingStatus;
  closed: boolean;
  moderationStatus: ModerationStatus | null;
};

const applicationInclude = {
  tutor: {
    select: {
      id: true,
      name: true,
      gender: true,
      instituteName: true,
      ratingAvg: true,
      ratingCount: true,
    },
  },
  student: {
    select: { id: true, name: true, areaId: true },
  },
  requirement: {
    select: {
      id: true,
      areaId: true,
      curriculum: true,
      levelCode: true,
      academicGroup: true,
      salary: true,
      daysPerWeek: true,
      timeOfDay: true,
      status: true,
      subjects: { select: { subjectId: true } },
    },
  },
  package: {
    select: {
      id: true,
      requirementId: true,
      subjectId: true,
      areaId: true,
      curriculum: true,
      levelCode: true,
      academicGroup: true,
      expectedSalary: true,
      daysPerWeek: true,
      timeOfDay: true,
      status: true,
      moderationStatus: true,
    },
  },
} satisfies Prisma.ApplicationInclude;

type AppRow = Prisma.ApplicationGetPayload<{ include: typeof applicationInclude }>;

type ClosedSets = { requirementIds: Set<string>; packageIds: Set<string> };

export function toTimeString(d: Date): string;
export function toTimeString(d: Date | null): string | null;
export function toTimeString(d: Date | null): string | null {
  return d ? d.toISOString().slice(11, 16) : null;
}

export function computeAllowedActions(
  app: { status: ApplicationStatus; initiatedBy: InitiatedBy; confirmedAt: Date | null },
  side: Side | null,
  target: TargetState,
): ApplicationAction[] {
  if (side === null) return [];
  const isInitiator = side === app.initiatedBy;

  switch (app.status) {
    case "PENDING":
      return isInitiator ? ["withdraw"] : ["confirm", "reject"];
    case "WITHDRAWN":
    case "REJECTED":
    case "EXPIRED": {
      if (app.confirmedAt !== null || !isInitiator) return [];
      const listingOpen = target.status === "OPEN" && !target.closed;
      // Requirements carry no moderation (null); packages must be APPROVED to be reopened.
      const moderationOk =
        target.moderationStatus === null || target.moderationStatus === "APPROVED";
      return listingOpen && moderationOk ? ["reopen"] : [];
    }
    case "CONFIRMED":
      return ["cancel", "complete"];
    default:
      return [];
  }
}

// One grouped query: which requirements / packages already have a CONFIRMED or COMPLETED application.
async function loadClosedFor(
  rows: Pick<AppRow, "requirementId" | "packageId">[],
): Promise<ClosedSets> {
  const sets: ClosedSets = { requirementIds: new Set(), packageIds: new Set() };
  const requirementIds = [
    ...new Set(rows.flatMap((r) => (r.requirementId ? [r.requirementId] : []))),
  ];
  const packageIds = [...new Set(rows.flatMap((r) => (r.packageId ? [r.packageId] : [])))];

  const or: Prisma.ApplicationWhereInput[] = [];
  if (requirementIds.length > 0) or.push({ requirementId: { in: requirementIds } });
  if (packageIds.length > 0) or.push({ packageId: { in: packageIds } });
  if (or.length === 0) return sets;

  const closing = await prisma.application.findMany({
    where: { status: { in: ["CONFIRMED", "COMPLETED"] }, OR: or },
    select: { requirementId: true, packageId: true },
  });
  for (const row of closing) {
    if (row.requirementId) sets.requirementIds.add(row.requirementId);
    if (row.packageId) sets.packageIds.add(row.packageId);
  }
  return sets;
}

function isClosed(row: AppRow, sets: ClosedSets): boolean {
  if (row.requirementId) return sets.requirementIds.has(row.requirementId);
  if (row.packageId) return sets.packageIds.has(row.packageId);
  return false;
}

function toTargetAndState(
  row: AppRow,
  closed: boolean,
): { target: ApplicationResponse["target"]; state: TargetState } {
  if (row.requirement) {
    const r = row.requirement;
    return {
      target: {
        kind: "REQUIREMENT",
        id: r.id,
        status: r.status,
        closed,
        areaId: r.areaId,
        subjectIds: r.subjects.map((s) => s.subjectId),
        curriculum: r.curriculum,
        levelCode: r.levelCode,
        academicGroup: r.academicGroup,
        salary: r.salary,
        daysPerWeek: r.daysPerWeek,
        timeOfDay: toTimeString(r.timeOfDay),
      },
      state: { status: r.status, closed, moderationStatus: null },
    };
  }
  if (row.package) {
    const p = row.package;
    return {
      target: {
        kind: "PACKAGE",
        id: p.id,
        status: p.status,
        closed,
        areaId: p.areaId,
        subjectIds: [p.subjectId],
        curriculum: p.curriculum,
        levelCode: p.levelCode,
        academicGroup: p.academicGroup,
        salary: p.expectedSalary,
        daysPerWeek: p.daysPerWeek,
        timeOfDay: toTimeString(p.timeOfDay),
      },
      state: { status: p.status, closed, moderationStatus: p.moderationStatus },
    };
  }
  throw new Error(`Application ${row.id} has neither a requirement nor a package`);
}

function toApplication(row: AppRow, side: Side | null, closed: boolean): ApplicationResponse {
  const { target, state } = toTargetAndState(row, closed);
  return {
    id: row.id,
    initiatedBy: row.initiatedBy,
    status: row.status,
    appliedAt: row.appliedAt,
    confirmedAt: row.confirmedAt,
    endedAt: row.endedAt,
    tutor: {
      id: row.tutor.id,
      name: row.tutor.name,
      gender: row.tutor.gender,
      instituteName: row.tutor.instituteName,
      ratingAvg: Number(row.tutor.ratingAvg),
      ratingCount: row.tutor.ratingCount,
    },
    student: {
      id: row.student.id,
      name: row.student.name,
      areaId: row.student.areaId,
    },
    target,
    allowedActions: computeAllowedActions(row, side, state),
  };
}

async function isActiveAdmin(accountId: string): Promise<boolean> {
  const admin = await prisma.adminUser.findUnique({
    where: { accountId },
    select: { status: true },
  });
  return admin?.status === "ACTIVE";
}

// The caller's side on this application, or null when the caller is not a party.
async function sideOf(row: AppRow, account: AuthContext): Promise<Side | null> {
  if (account.role === "TUTOR") {
    const tutor = await prisma.tutor.findUnique({
      where: { accountId: account.accountId },
      select: { id: true },
    });
    return tutor && tutor.id === row.tutorId ? "TUTOR" : null;
  }
  if (account.role === "STUDENT") {
    const student = await prisma.student.findUnique({
      where: { accountId: account.accountId },
      select: { id: true },
    });
    return student && student.id === row.studentId ? "STUDENT" : null;
  }
  return null;
}

// The other party's numbers. Only once the application is CONFIRMED or COMPLETED.
async function counterpartContactOf(row: AppRow, side: Side | null) {
  if (side === null) return null;
  if (row.status !== "CONFIRMED" && row.status !== "COMPLETED") return null;

  const other =
    side === "TUTOR"
      ? await prisma.student.findUnique({
          where: { id: row.studentId },
          select: { phoneNumber: true, whatsappNumber: true },
        })
      : await prisma.tutor.findUnique({
          where: { id: row.tutorId },
          select: { phoneNumber: true, whatsappNumber: true },
        });
  return other ? { phoneNumber: other.phoneNumber, whatsappNumber: other.whatsappNumber } : null;
}

const setInclude = {
  subjects: { select: { subjectId: true }, orderBy: { subjectId: "asc" } },
} satisfies Prisma.TutorRequirementInclude;

// One of the tutor's sets, in the detail shape. Null when no set matches the filter.
async function findTutorSet(
  where: Prisma.TutorRequirementWhereInput,
): Promise<ApplicationTutorSet["set"] | null> {
  const row = await prisma.tutorRequirement.findFirst({ where, include: setInclude });
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    isDefault: row.isDefault,
    levelMin: row.levelMin,
    levelMax: row.levelMax,
    curricula: row.curricula,
    academicGroups: row.academicGroups,
    admissionTargets: row.admissionTargets,
    subjectIds: row.subjects.map((s) => s.subjectId),
    timeFrom: toTimeString(row.timeFrom),
    timeTo: toTimeString(row.timeTo),
    availableDays: row.availableDays,
    minSalary: row.minSalary,
    maxStudents: row.maxStudents,
    teachesOnline: row.teachesOnline,
  };
}

// The tutor's active set that covers the requirement: default first, then most shared subjects,
// then newest. One query, using the same four-rule filter as the browse (setMatchesRequirementSql).
async function matchedSetIdOf(requirementId: string, tutorId: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT tr.id
    FROM tutor_requirement tr
    JOIN tuition_requirement r ON r.id = ${requirementId}::uuid
    LEFT JOIN student_location sl ON sl.student_id = r.student_id
    WHERE tr.tutor_id = ${tutorId}::uuid
      AND tr.is_active
      AND ${setMatchesRequirementSql()}
    ORDER BY tr.is_default DESC,
             (SELECT count(*)
              FROM tutor_requirement_subject trs
              JOIN requirement_subject rs ON rs.subject_id = trs.subject_id
              WHERE trs.requirement_id = tr.id AND rs.requirement_id = r.id) DESC,
             tr.created_at DESC
    LIMIT 1
  `;
  return rows[0]?.id ?? null;
}

// The set behind an application. Requirement: a matching set (MATCH), else the default set
// (DEFAULT). Package: the package's own set (PACKAGE); a package without one belongs to the
// tutor's default set. Null when there is no set to show.
async function tutorSetOf(row: AppRow): Promise<ApplicationTutorSet | null> {
  const { tutorId } = row;
  if (row.package) {
    const { requirementId } = row.package;
    const set = requirementId
      ? await findTutorSet({ id: requirementId, tutorId })
      : await findTutorSet({ tutorId, isDefault: true, isActive: true });
    return set ? { matchedBy: "PACKAGE", set } : null;
  }
  const matchedId = row.requirementId ? await matchedSetIdOf(row.requirementId, tutorId) : null;
  if (matchedId) {
    const set = await findTutorSet({ id: matchedId, tutorId });
    if (set) return { matchedBy: "MATCH", set };
  }
  const fallback = await findTutorSet({ tutorId, isDefault: true, isActive: true });
  return fallback ? { matchedBy: "DEFAULT", set: fallback } : null;
}

// The tutor's details for the student. Credentials carry only id, exam label and result.
async function tutorProfileOf(tutorId: string): Promise<ApplicationTutorProfile | null> {
  const tutor = await prisma.tutor.findUnique({
    where: { id: tutorId },
    select: {
      id: true,
      name: true,
      gender: true,
      instituteName: true,
      ratingAvg: true,
      ratingCount: true,
      verificationStatus: true,
      areas: { select: { area: { select: { id: true, name: true } } }, orderBy: { areaId: "asc" } },
      subjects: {
        select: { subject: { select: { id: true, name: true } } },
        orderBy: { subjectId: "asc" },
      },
      credentials: { select: { id: true, examLabel: true, result: true }, orderBy: { id: "asc" } },
    },
  });
  if (!tutor) return null;
  return {
    id: tutor.id,
    name: tutor.name,
    gender: tutor.gender,
    instituteName: tutor.instituteName,
    ratingAvg: Number(tutor.ratingAvg),
    ratingCount: tutor.ratingCount,
    verificationStatus: tutor.verificationStatus,
    areas: tutor.areas.map((a) => a.area),
    subjects: tutor.subjects.map((s) => s.subject),
    credentials: tutor.credentials,
  };
}

// Latest PLACEMENT fee that is not VOID, else the latest VOID one, else null.
async function placementFeeOf(row: AppRow): Promise<ApplicationDetailResponse["fee"]> {
  const fees = await prisma.platformFee.findMany({
    where: { applicationId: row.id, feeType: "PLACEMENT" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const fee = fees.find((f) => f.status !== "VOID") ?? fees[0];
  if (!fee) return null;

  const unpaid =
    (fee.status === "DUE" || fee.status === "PARTIAL") &&
    row.confirmedAt !== null &&
    row.confirmedAt.getTime() + FEE_UNPAID_AFTER_DAYS * DAY_MS < Date.now();

  return {
    id: fee.id,
    amountDue: fee.amountDue.toFixed(2),
    amountPaid: fee.amountPaid.toFixed(2),
    status: fee.status,
    dueDate: fee.dueDate.toISOString().slice(0, 10),
    unpaid,
  };
}

function emptyPage(): ApplicationPageResponse {
  return { applications: [], nextCursor: null };
}

// Keyset page over (appliedAt desc, id desc). `side` is the caller's side for every row in `scope`.
async function fetchPage(
  scope: Prisma.ApplicationWhereInput,
  side: Side,
  query: ApplicationListQuery,
  defaultLimit: number,
): Promise<ApplicationPageResponse> {
  const limit = query.limit ?? defaultLimit;
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;

  const rows = await prisma.application.findMany({
    where: {
      AND: [
        scope,
        query.status ? { status: query.status } : {},
        cursor
          ? {
              OR: [
                { appliedAt: { lt: cursor.createdAt } },
                { appliedAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {},
      ],
    },
    include: applicationInclude,
    orderBy: [{ appliedAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const closed = await loadClosedFor(page);

  return {
    applications: page.map((row) => toApplication(row, side, isClosed(row, closed))),
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.appliedAt, id: last.id }) : null,
  };
}

export async function getApplicationForCaller(
  id: string,
  account: AuthContext,
): Promise<ApplicationDetailResponse> {
  const row = await prisma.application.findUnique({ where: { id }, include: applicationInclude });
  if (!row) throw notFound("Application not found");

  const side = await sideOf(row, account);
  const adminView =
    side === null && account.role === "ADMIN" && (await isActiveAdmin(account.accountId));
  if (side === null && !adminView) throw notFound("Application not found");

  const closed = await loadClosedFor([row]);
  const base = toApplication(row, side, isClosed(row, closed));
  const counterpartContact = adminView ? null : await counterpartContactOf(row, side);
  const fee = side === "TUTOR" || adminView ? await placementFeeOf(row) : null;
  // The tutor's details and set are for the student and admins only.
  const seesTutor = side === "STUDENT" || adminView;
  const tutorProfile = seesTutor ? await tutorProfileOf(row.tutorId) : null;
  const tutorSet = seesTutor ? await tutorSetOf(row) : null;

  return { ...base, counterpartContact, fee, tutorProfile, tutorSet };
}

export async function listMyApplications(
  account: AuthContext,
  query: ApplicationListQuery,
): Promise<ApplicationPageResponse> {
  if (account.role === "TUTOR") {
    const tutor = await prisma.tutor.findUnique({
      where: { accountId: account.accountId },
      select: { id: true },
    });
    if (!tutor) return emptyPage();
    return fetchPage({ tutorId: tutor.id }, "TUTOR", query, 20);
  }
  if (account.role === "STUDENT") {
    const student = await prisma.student.findUnique({
      where: { accountId: account.accountId },
      select: { id: true },
    });
    if (!student) return emptyPage();
    return fetchPage({ studentId: student.id }, "STUDENT", query, 20);
  }
  // Admins do not list applications.
  return emptyPage();
}

export async function listRequirementApplications(
  requirementId: string,
  account: AuthContext,
  query: ApplicationListQuery,
): Promise<ApplicationPageResponse> {
  const student =
    account.role === "STUDENT"
      ? await prisma.student.findUnique({
          where: { accountId: account.accountId },
          select: { id: true },
        })
      : null;
  const requirement = student
    ? await prisma.tuitionRequirement.findFirst({
        where: { id: requirementId, studentId: student.id },
        select: { id: true },
      })
    : null;
  if (!requirement) throw notFound("Requirement not found");

  return fetchPage({ requirementId }, "STUDENT", query, 25);
}

export async function listPackageApplications(
  packageId: string,
  account: AuthContext,
  query: ApplicationListQuery,
): Promise<ApplicationPageResponse> {
  const tutor =
    account.role === "TUTOR"
      ? await prisma.tutor.findUnique({
          where: { accountId: account.accountId },
          select: { id: true },
        })
      : null;
  const pkg = tutor
    ? await prisma.tuitionPackage.findFirst({
        where: { id: packageId, tutorId: tutor.id },
        select: { id: true },
      })
    : null;
  if (!pkg) throw notFound("Package not found");

  return fetchPage({ packageId }, "TUTOR", query, 100);
}
