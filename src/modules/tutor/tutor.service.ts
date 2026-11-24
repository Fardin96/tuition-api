import type {
  FileAsset,
  Prisma,
  TutorRequirement,
  TutorVideo,
} from "../../generated/prisma/client.js";
import { avatarSelect, avatarUrlFor, withAvatarUrl } from "../../lib/avatar.js";
import { assertContactNumbersFree, mapContactNumberError } from "../../lib/contact-numbers.js";
import { DAYS_PER_WEEK_MESSAGE, daysPerWeekFits } from "../../lib/days.js";
import { toDistrictCode } from "../../lib/districts.js";
import { validateTutorCoverage } from "../../lib/education.js";
import { appError, validationIssuesError } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { tutorBadges } from "../../lib/profile-strength.js";
import type { AuthContext } from "../auth/auth.schema.js";
import { MAX_TUTOR_CREDENTIALS, MAX_TUTOR_VIDEOS } from "../files/file-policy.js";
import { claimFile, discardFile, fileUrl, removeObjects } from "../files/files.service.js";
import { visibleNote } from "../files/upload-review.service.js";
import {
  findOwnLocation,
  getTutorNeedsReaddress,
  type OwnLocation,
  type SaveLocationInput,
  upsertLocation,
} from "../location/location.service.js";
import { instituteFields } from "../lookups/institutions.service.js";
import {
  assertPhoneVerifiedForSignup,
  consumeOtp,
  findVerifiedOtp,
  isPhoneVerificationRequired,
} from "../phone-verification/phone-verification.policy.js";
import { pageVisibleReviews, reviewSummary } from "../review/review.service.js";
import { removeSourceFromLanding } from "../site-content/site-content.service.js";
import type {
  CreateCredentialInput,
  CreateTutorRequirementInput,
  CreateVideoInput,
  TutorRequirementListQuery,
  UpdateTutorRequirementInput,
} from "./tutor.schema.js";
import { MAX_PROFILE_SUBJECTS } from "./tutor.schema.js";

function toNumber(value: unknown) {
  return Number(value);
}

// Default-deny: public reads list fields here, never the whole row (contact numbers, address, parents, IDs).
export const tutorPublicSelect = {
  id: true,
  name: true,
  instituteName: true,
  gender: true,
  ratingAvg: true,
  ratingCount: true,
  verificationStatus: true,
  isListed: true,
  createdAt: true,
  updatedAt: true,
  areas: { select: { area: { select: { id: true, name: true } } } },
  subjects: { select: { subject: { select: { id: true, name: true } } } },
  // Only for avatarUrl: the account itself never leaves the API (see withAvatarUrl).
  account: { select: avatarSelect },
} as const;

function serializeTutor(
  tutor: {
    id: string;
    accountId: string;
    name: string;
    instituteName: string | null;
    address: string;
    emergencyContact: string | null;
    phoneNumber: string;
    whatsappNumber: string | null;
    studentIdNumber: string | null;
    gender: string;
    parentsInfo: string | null;
    whatsappVerifiedAt: Date | null;
    verificationStatus: string;
    isListed: boolean;
    ratingAvg: unknown;
    ratingCount: number;
    createdAt: Date;
    updatedAt: Date;
  },
  location: OwnLocation | null,
) {
  return {
    ...tutor,
    ratingAvg: toNumber(tutor.ratingAvg),
    whatsappVerifiedAt: tutor.whatsappVerifiedAt?.toISOString() ?? null,
    location,
    needsReaddress: location?.needsReaddress ?? false,
    createdAt: tutor.createdAt.toISOString(),
    updatedAt: tutor.updatedAt.toISOString(),
  };
}

export async function createTutorProfile(
  accountId: string,
  data: {
    name: string;
    instituteName?: string;
    institutionId?: number | null;
    address: string;
    emergencyContact: string;
    phoneNumber: string;
    whatsappNumber?: string | null;
    studentIdNumber: string;
    gender: "MALE" | "FEMALE" | "OTHER";
    parentsInfo?: string;
    location?: SaveLocationInput;
  },
) {
  const existing = await prisma.tutor.findUnique({ where: { accountId } });
  if (existing) throw appError("ProfileExists", 409, "Tutor profile already exists");

  const numbers = { phoneNumber: data.phoneNumber, whatsappNumber: data.whatsappNumber };
  await assertContactNumbersFree(accountId, numbers);
  const otp = await assertPhoneVerifiedForSignup(prisma, "TUTOR", accountId, data.phoneNumber);

  const { location, instituteName, institutionId, ...profileData } = data;
  const tutor = await prisma.$transaction(async (tx) => {
    const institute = await instituteFields(tx, { institutionId, instituteName }, null);
    const created = await tx.tutor
      .create({
        data: {
          accountId,
          ...profileData,
          ...institute,
          phoneVerifiedAt: otp?.verifiedAt ?? null,
        },
      })
      .catch((e: unknown) => mapContactNumberError(e, accountId, numbers));
    if (otp) await consumeOtp(tx, otp.id);
    if (location) {
      await upsertLocation("tutor_location", created.id, location, tx);
    }
    await tx.$executeRaw`SELECT recompute_is_listed(${created.id}::uuid)`;
    return created;
  });

  return serializeTutor(tutor, await findOwnLocation("tutor_location", tutor.id));
}

export async function updateTutorProfile(
  accountId: string,
  data: Partial<{
    name: string;
    instituteName: string;
    institutionId: number | null;
    address: string;
    emergencyContact: string;
    phoneNumber: string;
    whatsappNumber: string | null;
    studentIdNumber: string;
    gender: "MALE" | "FEMALE" | "OTHER";
    parentsInfo?: string;
    location?: SaveLocationInput;
  }>,
) {
  const existing = await prisma.tutor.findUnique({ where: { accountId } });
  if (!existing) return null;

  const numbers = { phoneNumber: data.phoneNumber, whatsappNumber: data.whatsappNumber };
  await assertContactNumbersFree(accountId, numbers);

  const { location, instituteName, institutionId, ...profileData } = data;
  const whatsappChanged =
    data.whatsappNumber !== undefined && data.whatsappNumber !== existing.whatsappNumber;
  const newPhone = data.phoneNumber !== existing.phoneNumber ? data.phoneNumber : undefined;
  const tutor = await prisma.$transaction(async (tx) => {
    // A new number is saved verified only with a code verified for it; otherwise the trigger clears the timestamp.
    const otp = newPhone === undefined ? null : await findVerifiedOtp(tx, accountId, newPhone);
    if (newPhone !== undefined && !otp && (await isPhoneVerificationRequired("TUTOR", tx))) {
      throw appError("PhoneVerificationRequired", 403, "Verify the new number before saving it.");
    }
    const institute = await instituteFields(
      tx,
      { institutionId, instituteName },
      existing.institutionId,
    );
    const updated = await tx.tutor
      .update({
        where: { accountId },
        data: {
          ...profileData,
          ...institute,
          ...(whatsappChanged ? { whatsappVerifiedAt: null } : {}),
          ...(otp ? { phoneVerifiedAt: otp.verifiedAt } : {}),
        },
      })
      .catch((e: unknown) => mapContactNumberError(e, accountId, numbers));
    if (otp) await consumeOtp(tx, otp.id);
    // The phone rule is part of the listing check, so a changed number can flip is_listed.
    if (newPhone !== undefined) {
      await tx.$executeRaw`SELECT recompute_is_listed(${updated.id}::uuid)`;
    }
    if (location) {
      await upsertLocation("tutor_location", updated.id, location, tx);
    }
    return updated;
  });

  return serializeTutor(tutor, await findOwnLocation("tutor_location", tutor.id));
}

// A tutor's city is the district of their saved address; areas in any other district are refused.
// An inactive area is refused too, unless the tutor already has it.
async function assertAreasInTutorCity(tutorId: string, areaIds: number[], currentIds: number[]) {
  if (areaIds.length === 0) return;
  const owned = new Set(currentIds);
  const areas = await prisma.area.findMany({
    where: { id: { in: areaIds } },
    select: { id: true, district: true, isActive: true },
  });
  const location = await prisma.tutorLocation.findUnique({
    where: { tutorId },
    select: { districtCode: true },
  });
  const valid = new Set(
    areas
      .filter(
        (area) =>
          (area.isActive || owned.has(area.id)) &&
          (!location || toDistrictCode(area.district) === location.districtCode),
      )
      .map((area) => area.id),
  );
  const invalidAreaIds = areaIds.filter((id) => !valid.has(id));
  if (invalidAreaIds.length > 0) {
    throw appError("AreaOutsideCity", 409, "All areas must be within your city", {
      invalidAreaIds,
    });
  }
}

export async function replaceTutorAreas(accountId: string, areaIds: number[]) {
  const tutor = await prisma.tutor.findUnique({ where: { accountId } });
  if (!tutor) return null;
  const next = new Set(areaIds);
  const owned = await prisma.tutorArea.findMany({
    where: { tutorId: tutor.id },
    select: { areaId: true },
  });
  await assertAreasInTutorCity(
    tutor.id,
    [...next],
    owned.map((row) => row.areaId),
  );

  await prisma.$transaction(async (tx) => {
    const current = await tx.tutorArea.findMany({
      where: { tutorId: tutor.id },
      select: { areaId: true },
    });
    const currentIds = new Set(current.map((row) => row.areaId));
    const removed = [...currentIds].filter((id) => !next.has(id));
    const added = [...next].filter((id) => !currentIds.has(id));

    await tx.tutorArea.deleteMany({ where: { tutorId: tutor.id, areaId: { in: removed } } });
    await tx.tutorArea.createMany({
      data: added.map((areaId) => ({ tutorId: tutor.id, areaId })),
      skipDuplicates: true,
    });
  });

  return prisma.tutorArea.findMany({
    where: { tutorId: tutor.id },
    include: { area: { select: { id: true, name: true } } },
  });
}

export async function replaceTutorSubjects(accountId: string, subjectIds: number[]) {
  const tutor = await prisma.tutor.findUnique({ where: { accountId } });
  if (!tutor) return null;

  const next = new Set(subjectIds);

  await prisma.$transaction(async (tx) => {
    await lockTutor(tx, tutor.id);
    const current = await tx.tutorSubject.findMany({
      where: { tutorId: tutor.id },
      select: { subjectId: true },
    });
    const currentIds = new Set(current.map((row) => row.subjectId));
    const removed = [...currentIds].filter((id) => !next.has(id));
    const added = [...next].filter((id) => !currentIds.has(id));

    // The composite FKs cascade removed subjects into tutor_requirement_subject and package_subject.
    // Refuse when that would leave an active set or an OPEN package with no subjects.
    const orphanedSets = await tx.$queryRaw<{ id: string }[]>`
      SELECT r.id FROM tutor_requirement r
      JOIN tutor_requirement_subject s ON s.requirement_id = r.id
      WHERE r.tutor_id = ${tutor.id}::uuid AND r.is_active
      GROUP BY r.id
      HAVING bool_and(s.subject_id = ANY(${removed}::int[]))`;
    const orphanedPackages = await tx.$queryRaw<{ id: string }[]>`
      SELECT p.id FROM tuition_package p
      JOIN package_subject s ON s.package_id = p.id
      WHERE p.tutor_id = ${tutor.id}::uuid AND p.status = 'OPEN'
      GROUP BY p.id
      HAVING bool_and(s.subject_id = ANY(${removed}::int[]))`;
    if (orphanedSets.length > 0 || orphanedPackages.length > 0) {
      throw appError(
        "RequirementLosesLastSubject",
        409,
        "A requirement set or package would be left with no subjects.",
        {
          requirementIds: orphanedSets.map((row) => row.id),
          packageIds: orphanedPackages.map((row) => row.id),
        },
      );
    }

    await tx.tutorSubject.deleteMany({ where: { tutorId: tutor.id, subjectId: { in: removed } } });
    await tx.tutorSubject.createMany({
      data: added.map((subjectId) => ({ tutorId: tutor.id, subjectId })),
      skipDuplicates: true,
    });
  });

  return prisma.tutorSubject.findMany({
    where: { tutorId: tutor.id },
    include: { subject: { select: { id: true, name: true } } },
  });
}

// Sends an uploaded ID for review. The tutor_verification trigger copies PENDING onto the tutor.
export async function submitTutorVerification(accountId: string, fileId: string) {
  const tutor = await prisma.tutor.findUnique({ where: { accountId }, select: { id: true } });
  if (!tutor) return null;

  return prisma.$transaction(async (tx) => {
    await lockTutor(tx, tutor.id);
    const row = await tx.tutor.findUniqueOrThrow({
      where: { id: tutor.id },
      select: { studentIdNumber: true, verificationStatus: true },
    });
    if (!row.studentIdNumber?.trim()) {
      throw appError("ValidationError", 400, "Add your student ID number to your profile first.");
    }
    const latest = await tx.tutorVerification.findFirst({
      where: { tutorId: tutor.id },
      orderBy: { submittedAt: "desc" },
      select: { status: true },
    });
    if (latest?.status === "PENDING") {
      throw appError("InvalidVerificationState", 409, "Your ID is already under review.");
    }
    if (row.verificationStatus === "APPROVED") {
      throw appError("InvalidVerificationState", 409, "You're already verified.");
    }
    await claimFile(tx, { fileId, ownerAccountId: accountId, purpose: "TUTOR_ID" });
    return tx.tutorVerification.create({
      data: { tutorId: tutor.id, fileId },
      include: { file: { select: { id: true, status: true } } },
    });
  });
}

export async function getTutorVerifications(accountId: string) {
  const tutor = await prisma.tutor.findUnique({ where: { accountId } });
  if (!tutor) return null;
  const rows = await prisma.tutorVerification.findMany({
    where: { tutorId: tutor.id },
    orderBy: { submittedAt: "desc" },
    include: { file: { select: { id: true, status: true } } },
  });
  // The admin's note reaches the tutor only when it was shared.
  return rows.map(({ noteVisible, note, ...row }) => ({
    ...row,
    note: visibleNote(note, noteVisible),
  }));
}

// Tutors who joined within this many days are the "Emerging masters" on the landing page.
export const RECENT_TUTOR_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

// The same order on every page. The keyset cursor walks this order, so rows that don't change are
// never repeated or skipped; a tutor whose rating changes mid-walk can repeat or be missed.
const TUTOR_SEARCH_ORDER: Prisma.TutorOrderByWithRelationInput[] = [
  { ratingAvg: "desc" },
  { ratingCount: "desc" },
  { createdAt: "desc" },
  { id: "asc" },
];

// The last row of the previous page, in TUTOR_SEARCH_ORDER. `s` is the recent cutoff that the
// first page used, so one walk keeps one 90-day window.
type TutorCursor = {
  r: string; // ratingAvg, fixed 2dp
  c: number; // ratingCount
  t: string; // createdAt, ISO
  i: string; // id
  s?: string; // recent cutoff, ISO; only when recent
};

const RATING_CURSOR_PATTERN = /^\d(\.\d{1,2})?$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INT4_MAX = 2147483647;

function encodeTutorCursor(cursor: TutorCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function invalidCursor() {
  return validationIssuesError("Invalid cursor", [{ path: "cursor", message: "Invalid cursor" }]);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function decodeTutorCursor(raw: string): TutorCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw invalidCursor();
  }
  if (typeof parsed !== "object" || parsed === null) throw invalidCursor();
  const c = parsed as Record<string, unknown>;
  // The id must be a uuid: an invalid one would reach the uuid column and fail as a 500.
  const valid =
    typeof c.r === "string" &&
    RATING_CURSOR_PATTERN.test(c.r) &&
    Number(c.r) <= 5 &&
    Number.isInteger(c.c) &&
    (c.c as number) >= 0 &&
    (c.c as number) <= INT4_MAX &&
    isIsoDate(c.t) &&
    (c.s === undefined || isIsoDate(c.s)) &&
    typeof c.i === "string" &&
    UUID_PATTERN.test(c.i);
  if (!valid) throw invalidCursor();
  return {
    r: c.r as string,
    c: c.c as number,
    t: c.t as string,
    i: c.i as string,
    s: c.s as string | undefined,
  };
}

export const UNPAGED_SEARCH_MAX = 500;

// One badge query per page, not per row.
async function withBadges<T extends { id: string }>(rows: T[]) {
  const badges = await tutorBadges(
    prisma,
    rows.map((r) => r.id),
  );
  return rows.map((r) => ({ ...r, verifiedBadge: badges.get(r.id) ?? false }));
}

export async function searchTutors(filters: {
  area?: number;
  subject?: number;
  gender?: "MALE" | "FEMALE" | "OTHER";
  rating?: number;
  name?: string;
  district?: string;
  recent?: boolean;
  limit?: number;
  cursor?: string;
}) {
  // area and district both constrain the same tutor_area row, so they share one areas.some.
  const areaWhere: Prisma.TutorAreaWhereInput = {};
  if (filters.area) areaWhere.areaId = filters.area;
  if (filters.district) {
    // Prisma sends an insensitive equals as ILIKE, so % and _ would act as wildcards.
    const district = filters.district.replace(/[\\%_]/g, "\\$&");
    areaWhere.area = { district: { equals: district, mode: "insensitive" } };
  }

  const where: Prisma.TutorWhereInput = { isListed: true };
  if (filters.gender) where.gender = filters.gender;
  if (filters.rating !== undefined) where.ratingAvg = { gte: filters.rating };
  if (filters.name) where.name = { contains: filters.name, mode: "insensitive" };
  if (Object.keys(areaWhere).length > 0) where.areas = { some: areaWhere };
  if (filters.subject) where.subjects = { some: { subjectId: filters.subject } };

  const { limit } = filters;
  if (limit === undefined) {
    if (filters.recent) {
      where.createdAt = { gte: new Date(Date.now() - RECENT_TUTOR_DAYS * DAY_MS) };
    }
    const rows = await prisma.tutor.findMany({
      where,
      orderBy: TUTOR_SEARCH_ORDER,
      select: tutorPublicSelect,
      // Without a page size the list was unbounded, and every row now costs a badge lookup.
      take: UNPAGED_SEARCH_MAX,
    });
    return { rows: await withBadges(await Promise.all(rows.map(withAvatarUrl))), nextCursor: null };
  }

  const cursor = filters.cursor !== undefined ? decodeTutorCursor(filters.cursor) : undefined;
  // The first page sets the recent cutoff and the cursor carries it, so one walk keeps one window.
  const cutoff = filters.recent
    ? cursor?.s
      ? new Date(cursor.s)
      : new Date(Date.now() - RECENT_TUTOR_DAYS * DAY_MS)
    : undefined;
  if (cutoff) where.createdAt = { gte: cutoff };
  if (cursor) {
    // Prisma reads a decimal string as the exact value; the fixed 2dp form matches the column.
    const r = cursor.r;
    const t = new Date(cursor.t);
    where.AND = [
      {
        OR: [
          { ratingAvg: { lt: r } },
          { ratingAvg: r, ratingCount: { lt: cursor.c } },
          { ratingAvg: r, ratingCount: cursor.c, createdAt: { lt: t } },
          { ratingAvg: r, ratingCount: cursor.c, createdAt: t, id: { gt: cursor.i } },
        ],
      },
    ];
  }

  // One extra row tells us whether another page exists.
  const rows = await prisma.tutor.findMany({
    where,
    orderBy: TUTOR_SEARCH_ORDER,
    select: tutorPublicSelect,
    take: limit + 1,
  });
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    rows: await withBadges(await Promise.all(page.map(withAvatarUrl))),
    nextCursor:
      rows.length > limit && last
        ? encodeTutorCursor({
            r: last.ratingAvg.toFixed(2),
            c: last.ratingCount,
            t: last.createdAt.toISOString(),
            i: last.id,
            s: cutoff?.toISOString(),
          })
        : null,
  };
}

// Unlisted profiles are shown only to the tutor themself, to an ACTIVE admin, and to a student
// who has an application with this tutor. Everyone else gets the same answer as an unknown id.
async function canSeeUnlistedTutor(
  tutor: { id: string; accountId: string },
  viewer: AuthContext | undefined,
) {
  if (!viewer) return false;
  if (viewer.accountId === tutor.accountId) return true;
  if (viewer.role === "ADMIN") {
    const admin = await prisma.adminUser.findUnique({
      where: { accountId: viewer.accountId },
      select: { status: true },
    });
    if (admin?.status === "ACTIVE") return true;
  }
  if (viewer.role === "STUDENT") {
    const application = await prisma.application.findFirst({
      where: { tutorId: tutor.id, student: { accountId: viewer.accountId } },
      select: { id: true },
    });
    return application !== null;
  }
  return false;
}

// Returns null when the tutor does not exist or the viewer may not see an unlisted profile.
// isListed tells the route which Cache-Control to send.
export async function getPublicTutorProfile(tutorId: string, viewer?: AuthContext) {
  const row = await prisma.tutor.findUnique({
    where: { id: tutorId },
    select: {
      ...tutorPublicSelect,
      accountId: true,
      credentials: { include: { file: { select: { id: true, status: true } } } },
      videos: {
        where: { status: "APPROVED" },
        include: { file: videoFileSelect },
        orderBy: { sortOrder: "asc" },
      },
    },
  });
  if (!row) return null;
  const { accountId, account, ...tutor } = row;
  if (!tutor.isListed && !(await canSeeUnlistedTutor({ id: tutor.id, accountId }, viewer))) {
    return null;
  }
  const [avatarUrl, needsReaddress, badges, videos] = await Promise.all([
    avatarUrlFor(account),
    getTutorNeedsReaddress(tutor.id),
    tutorBadges(prisma, [tutor.id]),
    Promise.all(tutor.videos.map(publicVideoFields)),
  ]);
  return {
    isListed: tutor.isListed,
    profile: {
      ...tutor,
      avatarUrl,
      ratingAvg: toNumber(tutor.ratingAvg),
      createdAt: tutor.createdAt.toISOString(),
      updatedAt: tutor.updatedAt.toISOString(),
      needsReaddress,
      verifiedBadge: badges.get(tutor.id) ?? false,
      areas: tutor.areas.map((a) => a.area),
      subjects: tutor.subjects.map((s) => s.subject),
      videos,
    },
  };
}

// findNearbyTutors (location.service) returns only the distance-ordered core fields; this adds the card fields
// with one query for the whole page. Tutors that disappeared since the first query are dropped.
export async function addNearbyCardFields<T extends { id: string }>(tutors: T[]) {
  if (tutors.length === 0) return [];
  const rows = await prisma.tutor.findMany({
    where: { id: { in: tutors.map((tutor) => tutor.id) } },
    select: tutorPublicSelect,
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const cards = await Promise.all(
    tutors.map(async (tutor) => {
      const row = byId.get(tutor.id);
      if (!row) return null;
      return {
        ...tutor,
        instituteName: row.instituteName,
        avatarUrl: await avatarUrlFor(row.account),
        areas: row.areas.map((a) => a.area),
        subjects: row.subjects.map((s) => s.subject),
      };
    }),
  );
  return withBadges(cards.filter((card) => card !== null));
}

// One page of visible reviews students wrote about the tutor, with the rating summary. Null when there is no such tutor.
export async function getTutorReviews(tutorId: string, query: { cursor?: string; limit: number }) {
  const tutor = await prisma.tutor.findUnique({
    where: { id: tutorId },
    select: { ratingAvg: true, ratingCount: true },
  });
  if (!tutor) return null;

  const base = { tutorId, direction: "STUDENT_TO_TUTOR" } as const;
  const { rows, nextCursor } = await pageVisibleReviews(base, query, (where, take) =>
    prisma.review.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take,
      include: { student: { select: { id: true, name: true } } },
    }),
  );
  return {
    // Students may be minors, so a student author's photo is never shown on this public endpoint.
    reviews: rows.map(({ student, ...review }) => ({
      ...review,
      student: { id: student.id, name: student.name, avatarUrl: null },
    })),
    nextCursor,
    summary: await reviewSummary(base, tutor.ratingAvg, tutor.ratingCount),
  };
}

export async function getTutorCredentials(accountId: string) {
  const tutor = await prisma.tutor.findUnique({ where: { accountId } });
  if (!tutor) return null;
  return prisma.tutorCredential.findMany({
    where: { tutorId: tutor.id },
    include: { file: { select: { id: true, status: true } } },
    orderBy: { examLabel: "asc" },
  });
}

// Adds a credential. Limited to MAX_TUTOR_CREDENTIALS per tutor.
export async function addTutorCredential(accountId: string, input: CreateCredentialInput) {
  const tutor = await prisma.tutor.findUnique({ where: { accountId }, select: { id: true } });
  if (!tutor) return null;

  return prisma.$transaction(async (tx) => {
    await lockTutor(tx, tutor.id);
    const count = await tx.tutorCredential.count({ where: { tutorId: tutor.id } });
    if (count >= MAX_TUTOR_CREDENTIALS) {
      throw appError(
        "UploadLimitReached",
        409,
        `You can add at most ${MAX_TUTOR_CREDENTIALS} credentials.`,
        { limit: MAX_TUTOR_CREDENTIALS },
      );
    }
    await claimFile(tx, { fileId: input.fileId, ownerAccountId: accountId, purpose: "CREDENTIAL" });
    return tx.tutorCredential.create({
      data: {
        tutorId: tutor.id,
        examLabel: input.examLabel,
        result: input.result,
        fileId: input.fileId,
      },
      select: {
        id: true,
        examLabel: true,
        result: true,
        file: { select: { id: true, status: true } },
      },
    });
  });
}

export async function deleteTutorCredential(accountId: string, credentialId: string) {
  const tutor = await prisma.tutor.findUnique({ where: { accountId }, select: { id: true } });
  if (!tutor) return false;

  const removed = await prisma.$transaction(async (tx) => {
    const credential = await tx.tutorCredential.findFirst({
      where: { id: credentialId, tutorId: tutor.id },
      select: { id: true, fileId: true },
    });
    if (!credential) return null;
    await tx.tutorCredential.delete({ where: { id: credential.id } });
    return { file: await discardFile(tx, credential.fileId) };
  });
  if (!removed) return false;
  if (removed.file) await removeObjects([removed.file]);
  return true;
}

const videoFileSelect = { select: { id: true, status: true, storageKey: true, publishedAt: true } };

type VideoRow = TutorVideo & {
  file: Pick<FileAsset, "id" | "status" | "storageKey" | "publishedAt">;
};

// The storage key and publish time stay here; only the embeddable url leaves.
async function publicVideoFields(video: VideoRow) {
  return {
    id: video.id,
    title: video.title,
    sortOrder: video.sortOrder,
    createdAt: video.createdAt.toISOString(),
    url: await fileUrl(video.file),
    file: { id: video.file.id, status: video.file.status },
  };
}

async function ownerVideoFields(video: VideoRow) {
  return {
    ...(await publicVideoFields(video)),
    status: video.status,
    showOnHomePage: video.landingConsentAt !== null,
    // Hidden admin notes never reach the uploader.
    moderationNote: visibleNote(video.moderationNote, video.noteVisible),
  };
}

export async function getTutorVideos(accountId: string) {
  const tutor = await prisma.tutor.findUnique({ where: { accountId }, select: { id: true } });
  if (!tutor) return null;
  const rows = await prisma.tutorVideo.findMany({
    where: { tutorId: tutor.id },
    include: { file: videoFileSelect },
    orderBy: { sortOrder: "asc" },
  });
  return Promise.all(rows.map(ownerVideoFields));
}

// Adds a video as PENDING for moderation, after the tutor's existing ones.
export async function addTutorVideo(accountId: string, input: CreateVideoInput) {
  const tutor = await prisma.tutor.findUnique({ where: { accountId }, select: { id: true } });
  if (!tutor) return null;

  const video = await prisma.$transaction(async (tx) => {
    await lockTutor(tx, tutor.id);
    const count = await tx.tutorVideo.count({ where: { tutorId: tutor.id } });
    if (count >= MAX_TUTOR_VIDEOS) {
      throw appError("UploadLimitReached", 409, `You can add at most ${MAX_TUTOR_VIDEOS} videos.`, {
        limit: MAX_TUTOR_VIDEOS,
      });
    }
    await claimFile(tx, {
      fileId: input.fileId,
      ownerAccountId: accountId,
      purpose: "TUTOR_VIDEO",
    });
    const last = await tx.tutorVideo.aggregate({
      where: { tutorId: tutor.id },
      _max: { sortOrder: true },
    });
    return tx.tutorVideo.create({
      data: {
        tutorId: tutor.id,
        fileId: input.fileId,
        title: input.title,
        status: "PENDING",
        sortOrder: (last._max.sortOrder ?? -1) + 1,
      },
      include: { file: videoFileSelect },
    });
  });
  return ownerVideoFields(video);
}

// The tutor agrees (true) or withdraws (false) showing an approved video on the home page. Withdrawing
// takes the video off the landing page in the same transaction. 404 when the video is not the tutor's.
export async function setVideoHomePage(
  accountId: string,
  videoId: string,
  showOnHomePage: boolean,
) {
  const tutor = await prisma.tutor.findUnique({ where: { accountId }, select: { id: true } });
  if (!tutor) return null;

  const video = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM tutor_video WHERE id = ${videoId}::uuid AND tutor_id = ${tutor.id}::uuid FOR UPDATE`;
    const current = await tx.tutorVideo.findFirst({
      where: { id: videoId, tutorId: tutor.id },
      include: { file: videoFileSelect },
    });
    if (!current) return null;

    if (showOnHomePage) {
      if (!current.landingConsentAt) {
        await tx.tutorVideo.update({
          where: { id: videoId },
          data: { landingConsentAt: new Date() },
        });
      }
    } else {
      await removeSourceFromLanding(tx, { kind: "tutor_video", id: videoId }, accountId);
      await tx.tutorVideo.update({ where: { id: videoId }, data: { landingConsentAt: null } });
    }
    return tx.tutorVideo.findUniqueOrThrow({
      where: { id: videoId },
      include: { file: videoFileSelect },
    });
  });
  if (!video) return null;
  return ownerVideoFields(video);
}

export async function deleteTutorVideo(accountId: string, videoId: string) {
  const tutor = await prisma.tutor.findUnique({ where: { accountId }, select: { id: true } });
  if (!tutor) return false;

  const removed = await prisma.$transaction(async (tx) => {
    // The video row is locked first, then the landing lists, then the video is deleted.
    await tx.$queryRaw`SELECT id FROM tutor_video WHERE id = ${videoId}::uuid AND tutor_id = ${tutor.id}::uuid FOR UPDATE`;
    const video = await tx.tutorVideo.findFirst({
      where: { id: videoId, tutorId: tutor.id },
      select: { id: true, fileId: true },
    });
    if (!video) return null;
    await removeSourceFromLanding(tx, { kind: "tutor_video", id: video.id }, accountId);
    await tx.tutorVideo.delete({ where: { id: video.id } });
    return { file: await discardFile(tx, video.fileId) };
  });
  if (!removed) return false;
  if (removed.file) await removeObjects([removed.file]);
  return true;
}

export async function getApprovedVideos() {
  const rows = await prisma.tutorVideo.findMany({
    where: { status: "APPROVED" },
    include: {
      tutor: { select: { id: true, name: true } },
      file: videoFileSelect,
    },
    orderBy: { sortOrder: "asc" },
  });
  return Promise.all(
    rows.map(async (row) => ({
      ...(await publicVideoFields(row)),
      tutor: { id: row.tutor.id, name: row.tutor.name },
    })),
  );
}

const MAX_ACTIVE_REQUIREMENTS = 10;

const requirementInclude = {
  subjects: { select: { subjectId: true }, orderBy: { subjectId: "asc" } },
  zones: { select: { zoneId: true } },
} as const;

type TutorRequirementRow = TutorRequirement & {
  subjects: { subjectId: number }[];
  zones: { zoneId: string }[];
};

type RequirementValues = Omit<
  CreateTutorRequirementInput,
  "subjectIds" | "zoneIds" | "syncProfileSubjects"
>;

const hhmmOf = (d: Date) => d.toISOString().slice(11, 16);
const ymdOf = (d: Date) => d.toISOString().slice(0, 10);
const toTime = (t: string) => new Date(`1970-01-01T${t}:00Z`);
const toDay = (d: string) => new Date(`${d}T00:00:00Z`);

function limitError() {
  return appError(
    "RequirementLimitReached",
    409,
    `A tutor can have at most ${MAX_ACTIVE_REQUIREMENTS} active requirements`,
  );
}

function requirementData(values: RequirementValues) {
  return {
    ...values,
    timeFrom: toTime(values.timeFrom),
    timeTo: toTime(values.timeTo),
    availableFrom: toDay(values.availableFrom),
  };
}

function mapRequirementFkError(error: unknown): never {
  if ((error as { code?: string }).code === "P2003") {
    throw appError(
      "InvalidSubjectOrZone",
      400,
      "Subject or zone is not part of this tutor's profile",
    );
  }
  throw error;
}

async function lockTutor(tx: Prisma.TransactionClient, tutorId: string) {
  await tx.$queryRaw`SELECT id FROM tutor WHERE id = ${tutorId}::uuid FOR UPDATE`;
}

// Runs inside the caller's transaction, after lockTutor. With `sync`, subjects missing from the profile are added to it.
export async function prepareSetSubjects(
  tx: Prisma.TransactionClient,
  tutorId: string,
  subjectIds: number[],
  sync: boolean,
) {
  const found = await tx.subject.findMany({
    where: { id: { in: subjectIds }, isActive: true },
    select: { id: true },
  });
  const foundIds = new Set(found.map((row) => row.id));
  const missingIds = subjectIds.filter((id) => !foundIds.has(id));
  if (missingIds.length > 0) {
    throw appError("ValidationError", 400, "Unknown subject", { subjectIds: missingIds });
  }
  if (!sync) return;

  const current = await tx.tutorSubject.findMany({
    where: { tutorId },
    select: { subjectId: true },
  });
  const currentIds = new Set(current.map((row) => row.subjectId));
  const missing = subjectIds.filter((id) => !currentIds.has(id));
  if (missing.length === 0) return;
  if (current.length + missing.length > MAX_PROFILE_SUBJECTS) {
    throw appError(
      "ValidationError",
      400,
      `A tutor can have at most ${MAX_PROFILE_SUBJECTS} subjects`,
      { subjectIds: missing },
    );
  }
  await tx.tutorSubject.createMany({
    data: missing.map((subjectId) => ({ tutorId, subjectId })),
    skipDuplicates: true,
  });
}

function serializeTutorRequirement(row: TutorRequirementRow) {
  return {
    id: row.id,
    name: row.name,
    isDefault: row.isDefault,
    isActive: row.isActive,
    levelMin: row.levelMin,
    levelMax: row.levelMax,
    curricula: row.curricula,
    academicGroups: row.academicGroups,
    admissionTargets: row.admissionTargets,
    timeFrom: hhmmOf(row.timeFrom),
    timeTo: hhmmOf(row.timeTo),
    availableDays: row.availableDays,
    daysPerWeek: row.daysPerWeek,
    minSalary: row.minSalary,
    maxStudents: row.maxStudents,
    availableFrom: ymdOf(row.availableFrom),
    teachesOnline: row.teachesOnline,
    subjectIds: row.subjects.map((s) => s.subjectId),
    zoneIds: row.zones.map((z) => z.zoneId),
  };
}

async function findSerializedRequirement(tutorId: string, id: string) {
  const row = await prisma.tutorRequirement.findFirst({
    where: { id, tutorId },
    include: requirementInclude,
  });
  if (!row) return null;
  return serializeTutorRequirement(row);
}

export async function listTutorRequirements(
  accountId: string,
  status: TutorRequirementListQuery["status"] = "active",
) {
  const tutor = await prisma.tutor.findUnique({ where: { accountId } });
  if (!tutor) return null;

  const activeRows =
    status === "archived"
      ? []
      : await prisma.tutorRequirement.findMany({
          where: { tutorId: tutor.id, isActive: true },
          include: requirementInclude,
          orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
        });
  // shortcut: archived list capped at 50, switch to cursor pagination if tutors exceed it
  const archivedRows =
    status === "active"
      ? []
      : await prisma.tutorRequirement.findMany({
          where: { tutorId: tutor.id, isActive: false },
          include: requirementInclude,
          orderBy: { updatedAt: "desc" },
          take: 50,
        });
  const rows = [...activeRows, ...archivedRows];
  return rows.map((row) => serializeTutorRequirement(row));
}

export async function getTutorRequirement(accountId: string, id: string) {
  const tutor = await prisma.tutor.findUnique({ where: { accountId } });
  if (!tutor) return null;
  return findSerializedRequirement(tutor.id, id);
}

export async function createTutorRequirement(
  accountId: string,
  input: CreateTutorRequirementInput,
) {
  const tutor = await prisma.tutor.findUnique({ where: { accountId } });
  if (!tutor) return null;
  const { subjectIds, zoneIds, syncProfileSubjects, ...values } = input;

  try {
    const id = await prisma.$transaction(async (tx) => {
      await lockTutor(tx, tutor.id);
      await prepareSetSubjects(tx, tutor.id, subjectIds, syncProfileSubjects === true);
      const activeCount = await tx.tutorRequirement.count({
        where: { tutorId: tutor.id, isActive: true },
      });
      if (activeCount >= MAX_ACTIVE_REQUIREMENTS) throw limitError();
      const hasDefault =
        (await tx.tutorRequirement.count({ where: { tutorId: tutor.id, isDefault: true } })) > 0;

      const created = await tx.tutorRequirement.create({
        data: { ...requirementData(values), tutorId: tutor.id, isDefault: !hasDefault },
        select: { id: true },
      });
      await tx.tutorRequirementSubject.createMany({
        data: subjectIds.map((subjectId) => ({
          requirementId: created.id,
          subjectId,
          tutorId: tutor.id,
        })),
      });
      await tx.tutorRequirementZone.createMany({
        data: zoneIds.map((zoneId) => ({ requirementId: created.id, zoneId, tutorId: tutor.id })),
      });
      return created.id;
    });
    return findSerializedRequirement(tutor.id, id);
  } catch (error) {
    mapRequirementFkError(error);
  }
}

export async function updateTutorRequirement(
  accountId: string,
  id: string,
  input: UpdateTutorRequirementInput,
) {
  const tutor = await prisma.tutor.findUnique({ where: { accountId } });
  if (!tutor) return null;
  const existing = await prisma.tutorRequirement.findFirst({ where: { id, tutorId: tutor.id } });
  if (!existing) return null;

  const { subjectIds, zoneIds, syncProfileSubjects, ...scalars } = input;
  const values: RequirementValues = {
    name: existing.name,
    levelMin: existing.levelMin,
    levelMax: existing.levelMax,
    curricula: existing.curricula,
    academicGroups: existing.academicGroups,
    admissionTargets: existing.admissionTargets,
    timeFrom: hhmmOf(existing.timeFrom),
    timeTo: hhmmOf(existing.timeTo),
    availableDays: existing.availableDays,
    daysPerWeek: existing.daysPerWeek,
    minSalary: existing.minSalary,
    maxStudents: existing.maxStudents,
    availableFrom: ymdOf(existing.availableFrom),
    teachesOnline: existing.teachesOnline,
    ...scalars,
  };
  const issues = validateTutorCoverage(values);
  if (issues.length > 0) {
    throw appError("InvalidRequirement", 400, issues[0].message, {
      fields: issues.map((i) => i.path),
    });
  }
  if (values.timeTo <= values.timeFrom) {
    throw appError("InvalidRequirement", 400, "timeTo must be after timeFrom", {
      fields: ["timeTo"],
    });
  }
  if (!daysPerWeekFits(values.daysPerWeek, values.availableDays)) {
    throw appError("InvalidRequirement", 400, DAYS_PER_WEEK_MESSAGE, {
      fields: ["daysPerWeek"],
    });
  }

  try {
    await prisma.$transaction(async (tx) => {
      await lockTutor(tx, tutor.id);
      // A set needs a zone or online teaching. Check the merged result before any write.
      if (!values.teachesOnline) {
        const zoneCount =
          zoneIds !== undefined
            ? new Set(zoneIds).size
            : await tx.tutorRequirementZone.count({ where: { requirementId: id } });
        if (zoneCount === 0) {
          throw appError("InvalidRequirement", 400, "Pick a zone or turn on online teaching", {
            fields: ["zoneIds"],
          });
        }
      }
      if (subjectIds !== undefined) {
        await prepareSetSubjects(tx, tutor.id, subjectIds, syncProfileSubjects === true);
        const current = await tx.tutorRequirementSubject.findMany({
          where: { requirementId: id },
          select: { subjectId: true },
        });
        const { removed, added } = diffIds(
          current.map((row) => row.subjectId),
          subjectIds,
        );
        await tx.tutorRequirementSubject.deleteMany({
          where: { requirementId: id, subjectId: { in: removed } },
        });
        await tx.tutorRequirementSubject.createMany({
          data: added.map((subjectId) => ({ requirementId: id, tutorId: tutor.id, subjectId })),
          skipDuplicates: true,
        });
      }

      if (zoneIds !== undefined) {
        const current = await tx.tutorRequirementZone.findMany({
          where: { requirementId: id },
          select: { zoneId: true },
        });
        const { removed, added } = diffIds(
          current.map((row) => row.zoneId),
          zoneIds,
        );
        await tx.tutorRequirementZone.deleteMany({
          where: { requirementId: id, zoneId: { in: removed } },
        });
        await tx.tutorRequirementZone.createMany({
          data: added.map((zoneId) => ({ requirementId: id, tutorId: tutor.id, zoneId })),
          skipDuplicates: true,
        });
      }

      await tx.tutorRequirement.update({ where: { id }, data: requirementData(values) });
    });
    return findSerializedRequirement(tutor.id, id);
  } catch (error) {
    mapRequirementFkError(error);
  }
}

function diffIds<T>(current: T[], next: T[]) {
  const currentSet = new Set(current);
  const nextSet = new Set(next);
  return {
    removed: current.filter((id) => !nextSet.has(id)),
    added: [...nextSet].filter((id) => !currentSet.has(id)),
  };
}

export async function setDefaultTutorRequirement(accountId: string, id: string) {
  const tutor = await prisma.tutor.findUnique({ where: { accountId } });
  if (!tutor) return null;

  const found = await prisma.$transaction(async (tx) => {
    await lockTutor(tx, tutor.id);
    const row = await tx.tutorRequirement.findFirst({
      where: { id, tutorId: tutor.id },
      select: { isActive: true, isDefault: true },
    });
    if (!row) return false;
    if (!row.isActive) {
      throw appError("RequirementArchived", 409, "An archived requirement cannot be the default");
    }
    if (!row.isDefault) {
      await tx.tutorRequirement.updateMany({
        where: { tutorId: tutor.id, isDefault: true },
        data: { isDefault: false },
      });
      await tx.tutorRequirement.update({ where: { id }, data: { isDefault: true } });
    }
    return true;
  });
  return found ? findSerializedRequirement(tutor.id, id) : null;
}

export async function archiveTutorRequirement(accountId: string, id: string) {
  const tutor = await prisma.tutor.findUnique({ where: { accountId } });
  if (!tutor) return null;

  const found = await prisma.$transaction(async (tx) => {
    await lockTutor(tx, tutor.id);
    const row = await tx.tutorRequirement.findFirst({
      where: { id, tutorId: tutor.id },
      select: { isActive: true, isDefault: true },
    });
    if (!row) return false;
    if (!row.isActive) return true;
    if (row.isDefault) {
      throw appError("RequirementIsDefault", 409, "The default requirement cannot be archived");
    }
    await tx.tutorRequirement.update({ where: { id }, data: { isActive: false } });
    return true;
  });
  return found ? findSerializedRequirement(tutor.id, id) : null;
}

export async function restoreTutorRequirement(accountId: string, id: string) {
  const tutor = await prisma.tutor.findUnique({ where: { accountId } });
  if (!tutor) return null;

  const found = await prisma.$transaction(async (tx) => {
    await lockTutor(tx, tutor.id);
    const row = await tx.tutorRequirement.findFirst({
      where: { id, tutorId: tutor.id },
      select: { isActive: true },
    });
    if (!row) return false;
    if (row.isActive) return true;
    const subjectCount = await tx.tutorRequirementSubject.count({ where: { requirementId: id } });
    if (subjectCount === 0) {
      throw appError(
        "RequirementHasNoSubjects",
        409,
        "Add at least one subject before restoring this requirement",
      );
    }
    const activeCount = await tx.tutorRequirement.count({
      where: { tutorId: tutor.id, isActive: true },
    });
    if (activeCount >= MAX_ACTIVE_REQUIREMENTS) throw limitError();
    await tx.tutorRequirement.update({ where: { id }, data: { isActive: true } });
    return true;
  });
  return found ? findSerializedRequirement(tutor.id, id) : null;
}
