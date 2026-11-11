import { assertContactNumbersFree, mapContactNumberError } from "../../lib/contact-numbers.js";
import { prisma } from "../../lib/prisma.js";
import {
  findOwnLocation,
  getTutorNeedsReaddress,
  type OwnLocation,
  type SaveLocationInput,
  upsertLocation,
} from "../location/location.service.js";

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
    whatsappNumber: string;
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
    phoneNumber?: string;
    whatsappNumber: string;
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

  const numbers = {
    phoneNumber: data.phoneNumber ?? data.whatsappNumber,
    whatsappNumber: data.whatsappNumber,
  };
  await assertContactNumbersFree(accountId, numbers);

  const { location, ...profileData } = data;
  const tutor = await prisma.$transaction(async (tx) => {
    const created = await tx.tutor
      .create({ data: { accountId, ...profileData, phoneNumber: numbers.phoneNumber } })
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
    whatsappNumber: string;
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
  const tutor = await prisma.tutor
    .update({ where: { accountId }, data: profileData })
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
