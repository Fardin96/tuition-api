import type { Prisma, TutorRequirement } from "../../generated/prisma/client.js";
import { assertContactNumbersFree, mapContactNumberError } from "../../lib/contact-numbers.js";
import { prisma } from "../../lib/prisma.js";
import {
  findOwnLocation,
  getTutorNeedsReaddress,
  type OwnLocation,
  type SaveLocationInput,
  upsertLocation,
} from "../location/location.service.js";
import type {
  CreateTutorRequirementInput,
  TutorRequirementListQuery,
  UpdateTutorRequirementInput,
} from "./tutor.schema.js";

function toNumber(value: unknown) {
  return Number(value);
}

// Default-deny: public reads list fields here, never the whole row (contact numbers, address, parents, IDs).
export const tutorPublicSelect = {
  id: true,
  name: true,
  gender: true,
  ratingAvg: true,
  ratingCount: true,
  verificationStatus: true,
  isListed: true,
  createdAt: true,
  updatedAt: true,
  areas: { select: { area: { select: { id: true, name: true } } } },
  subjects: { select: { subject: { select: { id: true, name: true } } } },
} as const;

function serializeTutor(
  tutor: {
    id: string;
    accountId: string;
    name: string;
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
  if (existing) {
    const err = new Error("Tutor profile already exists");
    Object.assign(err, { statusCode: 409 });
    throw err;
  }

  const numbers = { phoneNumber: data.phoneNumber, whatsappNumber: data.whatsappNumber };
  await assertContactNumbersFree(accountId, numbers);

  const { location, ...profileData } = data;
  const tutor = await prisma.$transaction(async (tx) => {
    const created = await tx.tutor
      .create({ data: { accountId, ...profileData } })
      .catch((e: unknown) => mapContactNumberError(e, accountId, numbers));
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

  const { location, ...profileData } = data;
  const whatsappChanged =
    data.whatsappNumber !== undefined && data.whatsappNumber !== existing.whatsappNumber;
  const tutor = await prisma.tutor
    .update({
      where: { accountId },
      data: whatsappChanged ? { ...profileData, whatsappVerifiedAt: null } : profileData,
    })
    .catch((e: unknown) => mapContactNumberError(e, accountId, numbers));

  if (location) {
    await upsertLocation("tutor_location", tutor.id, location);
  }

  return serializeTutor(tutor, await findOwnLocation("tutor_location", tutor.id));
}

export async function replaceTutorAreas(accountId: string, areaIds: number[]) {
  const tutor = await prisma.tutor.findUnique({ where: { accountId } });
  if (!tutor) return null;
  const next = new Set(areaIds);

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
    const current = await tx.tutorSubject.findMany({
      where: { tutorId: tutor.id },
      select: { subjectId: true },
    });
    const currentIds = new Set(current.map((row) => row.subjectId));
    const removed = [...currentIds].filter((id) => !next.has(id));
    const added = [...next].filter((id) => !currentIds.has(id));

    // The composite FK cascades removed subjects into tutor_requirement_subject; refuse if that empties an active set.
    const orphaned = await tx.$queryRaw<{ id: string }[]>`
      SELECT r.id FROM tutor_requirement r
      JOIN tutor_requirement_subject s ON s.requirement_id = r.id
      WHERE r.tutor_id = ${tutor.id}::uuid AND r.is_active
      GROUP BY r.id
      HAVING bool_and(s.subject_id = ANY(${removed}::int[]))`;
    if (orphaned.length > 0) {
      throw Object.assign(new Error("A requirement would be left with no subjects."), {
        name: "RequirementLosesLastSubject",
        statusCode: 409,
        code: "REQUIREMENT_LOSES_LAST_SUBJECT",
        requirementIds: orphaned.map((row) => row.id),
      });
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

export async function getTutorVerifications(accountId: string) {
  const tutor = await prisma.tutor.findUnique({ where: { accountId } });
  if (!tutor) return null;
  return prisma.tutorVerification.findMany({
    where: { tutorId: tutor.id },
    orderBy: { submittedAt: "desc" },
    include: { file: { select: { id: true, status: true } } },
  });
}

export async function searchTutors(filters: {
  area?: number;
  subject?: number;
  gender?: "MALE" | "FEMALE" | "OTHER";
  rating?: number;
  name?: string;
}) {
  const where: Record<string, unknown> = { isListed: true };

  if (filters.gender) where.gender = filters.gender;
  if (filters.rating !== undefined) where.ratingAvg = { gte: filters.rating };
  if (filters.name) where.name = { contains: filters.name, mode: "insensitive" };
  if (filters.area) where.areas = { some: { areaId: filters.area } };
  if (filters.subject) where.subjects = { some: { subjectId: filters.subject } };

  return prisma.tutor.findMany({
    where,
    orderBy: { ratingAvg: "desc" },
    select: tutorPublicSelect,
  });
}

export async function getPublicTutorProfile(tutorId: string) {
  const tutor = await prisma.tutor.findUnique({
    where: { id: tutorId },
    select: {
      ...tutorPublicSelect,
      credentials: { include: { file: { select: { id: true, status: true } } } },
      videos: {
        where: { status: "APPROVED" },
        include: { file: { select: { id: true, status: true } } },
      },
    },
  });
  if (!tutor) return null;
  return {
    ...tutor,
    ratingAvg: toNumber(tutor.ratingAvg),
    createdAt: tutor.createdAt.toISOString(),
    updatedAt: tutor.updatedAt.toISOString(),
    needsReaddress: await getTutorNeedsReaddress(tutor.id),
    areas: tutor.areas.map((a) => a.area),
    subjects: tutor.subjects.map((s) => s.subject),
  };
}

export async function getTutorReviews(tutorId: string) {
  return prisma.review.findMany({
    where: { tutorId, direction: "STUDENT_TO_TUTOR", status: "VISIBLE" },
    orderBy: { createdAt: "desc" },
    include: { student: { select: { id: true, name: true } } },
  });
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

export async function deleteTutorCredential(accountId: string, credentialId: string) {
  const tutor = await prisma.tutor.findUnique({ where: { accountId } });
  if (!tutor) return null;
  const result = await prisma.tutorCredential.deleteMany({
    where: { id: credentialId, tutorId: tutor.id },
  });
  return result.count > 0;
}

export async function getTutorVideos(accountId: string) {
  const tutor = await prisma.tutor.findUnique({ where: { accountId } });
  if (!tutor) return null;
  return prisma.tutorVideo.findMany({
    where: { tutorId: tutor.id },
    include: { file: { select: { id: true, status: true } } },
    orderBy: { sortOrder: "asc" },
  });
}

export async function deleteTutorVideo(accountId: string, videoId: string) {
  const tutor = await prisma.tutor.findUnique({ where: { accountId } });
  if (!tutor) return null;
  const result = await prisma.tutorVideo.deleteMany({
    where: { id: videoId, tutorId: tutor.id },
  });
  return result.count > 0;
}

export async function getApprovedVideos() {
  return prisma.tutorVideo.findMany({
    where: { status: "APPROVED" },
    include: {
      tutor: { select: { id: true, name: true } },
      file: { select: { id: true, status: true } },
    },
    orderBy: { sortOrder: "asc" },
  });
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

type RequirementValues = Omit<CreateTutorRequirementInput, "subjectIds" | "zoneIds">;

const hhmmOf = (d: Date) => d.toISOString().slice(11, 16);
const ymdOf = (d: Date) => d.toISOString().slice(0, 10);
const toTime = (t: string) => new Date(`1970-01-01T${t}:00Z`);
const toDay = (d: string) => new Date(`${d}T00:00:00Z`);

function requirementError(
  name: string,
  statusCode: number,
  code: string,
  message: string,
  extras: object = {},
) {
  return Object.assign(new Error(message), { name, statusCode, code, ...extras });
}

function limitError() {
  return requirementError(
    "RequirementLimitReached",
    409,
    "REQUIREMENT_LIMIT_REACHED",
    `A tutor can have at most ${MAX_ACTIVE_REQUIREMENTS} active requirements`,
  );
}

function inUseError(packageIds: string[]) {
  return requirementError(
    "RequirementInUse",
    409,
    "REQUIREMENT_IN_USE",
    "Requirement is used by open packages",
    { packageIds },
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
    throw requirementError(
      "InvalidSubjectOrZone",
      400,
      "INVALID_SUBJECT_OR_ZONE",
      "Subject or zone is not part of this tutor's profile",
    );
  }
  throw error;
}

// The archive trigger raises restrict_violation (SQLSTATE 23001) when open packages still use the set.
function isArchiveBlocked(error: unknown) {
  const { message = "", meta } = error as {
    message?: string;
    meta?: { database_error_code?: string };
  };
  return meta?.database_error_code === "23001" || message.includes("mapped to open packages");
}

async function lockTutor(tx: Prisma.TransactionClient, tutorId: string) {
  await tx.$queryRaw`SELECT id FROM tutor WHERE id = ${tutorId}::uuid FOR UPDATE`;
}

// One grouped query. Key null = OPEN packages without a requirement (they belong to the default set).
async function mappedPackageCounts(tutorId: string) {
  const rows = await prisma.$queryRaw<{ requirementId: string | null; count: number }[]>`
    SELECT requirement_id AS "requirementId", count(*)::int AS count
    FROM tuition_package
    WHERE tutor_id = ${tutorId}::uuid AND status = 'OPEN'
    GROUP BY requirement_id`;
  return new Map<string | null, number>(rows.map((row) => [row.requirementId, row.count]));
}

function serializeTutorRequirement(row: TutorRequirementRow, counts: Map<string | null, number>) {
  return {
    id: row.id,
    name: row.name,
    isDefault: row.isDefault,
    isActive: row.isActive,
    classLevelMin: row.classLevelMin,
    classLevelMax: row.classLevelMax,
    timeFrom: hhmmOf(row.timeFrom),
    timeTo: hhmmOf(row.timeTo),
    availableDays: row.availableDays,
    minSalary: row.minSalary,
    maxStudents: row.maxStudents,
    availableFrom: ymdOf(row.availableFrom),
    teachesOnline: row.teachesOnline,
    subjectIds: row.subjects.map((s) => s.subjectId),
    zoneIds: row.zones.map((z) => z.zoneId),
    mappedPackageCount: (counts.get(row.id) ?? 0) + (row.isDefault ? (counts.get(null) ?? 0) : 0),
  };
}

async function findSerializedRequirement(tutorId: string, id: string) {
  const row = await prisma.tutorRequirement.findFirst({
    where: { id, tutorId },
    include: requirementInclude,
  });
  if (!row) return null;
  return serializeTutorRequirement(row, await mappedPackageCounts(tutorId));
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
  const counts = await mappedPackageCounts(tutor.id);
  return rows.map((row) => serializeTutorRequirement(row, counts));
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
  const { subjectIds, zoneIds, ...values } = input;

  try {
    const id = await prisma.$transaction(async (tx) => {
      await lockTutor(tx, tutor.id);
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

  const { subjectIds, zoneIds, ...scalars } = input;
  const values: RequirementValues = {
    name: existing.name,
    classLevelMin: existing.classLevelMin,
    classLevelMax: existing.classLevelMax,
    timeFrom: hhmmOf(existing.timeFrom),
    timeTo: hhmmOf(existing.timeTo),
    availableDays: existing.availableDays,
    minSalary: existing.minSalary,
    maxStudents: existing.maxStudents,
    availableFrom: ymdOf(existing.availableFrom),
    teachesOnline: existing.teachesOnline,
    ...scalars,
  };
  if (
    values.classLevelMin < 1 ||
    values.classLevelMax > 20 ||
    values.classLevelMax < values.classLevelMin ||
    values.timeTo <= values.timeFrom
  ) {
    throw requirementError(
      "InvalidRequirement",
      400,
      "INVALID_REQUIREMENT",
      "Invalid requirement values",
    );
  }

  try {
    await prisma.$transaction(async (tx) => {
      if (subjectIds !== undefined) {
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
      throw requirementError(
        "RequirementArchived",
        409,
        "REQUIREMENT_ARCHIVED",
        "An archived requirement cannot be the default",
      );
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

  try {
    const found = await prisma.$transaction(async (tx) => {
      await lockTutor(tx, tutor.id);
      const row = await tx.tutorRequirement.findFirst({
        where: { id, tutorId: tutor.id },
        select: { isActive: true, isDefault: true },
      });
      if (!row) return false;
      if (!row.isActive) return true;
      if (row.isDefault) {
        throw requirementError(
          "RequirementIsDefault",
          409,
          "REQUIREMENT_IS_DEFAULT",
          "The default requirement cannot be archived",
        );
      }
      const packages = await tx.tuitionPackage.findMany({
        where: { requirementId: id, status: "OPEN" },
        select: { id: true },
      });
      if (packages.length > 0) throw inUseError(packages.map((p) => p.id));
      await tx.tutorRequirement.update({ where: { id }, data: { isActive: false } });
      return true;
    });
    return found ? findSerializedRequirement(tutor.id, id) : null;
  } catch (error) {
    if (!isArchiveBlocked(error)) throw error;
    const packages = await prisma.tuitionPackage.findMany({
      where: { requirementId: id, status: "OPEN" },
      select: { id: true },
    });
    throw inUseError(packages.map((p) => p.id));
  }
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
      throw requirementError(
        "RequirementHasNoSubjects",
        409,
        "REQUIREMENT_NO_SUBJECTS",
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
