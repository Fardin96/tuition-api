import { assertContactNumbersFree, mapContactNumberError } from "../../lib/contact-numbers.js";
import { prisma } from "../../lib/prisma.js";
import {
  getTutorNeedsReaddress,
  type SaveLocationInput,
  upsertTutorLocation,
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
  needsReaddress?: boolean,
) {
  return {
    ...tutor,
    ratingAvg: toNumber(tutor.ratingAvg),
    whatsappVerifiedAt: tutor.whatsappVerifiedAt?.toISOString() ?? null,
    needsReaddress,
    createdAt: tutor.createdAt.toISOString(),
    updatedAt: tutor.updatedAt.toISOString(),
  };
}

function locationFieldsPresent<
  T extends { placeId?: string; latitude?: number; longitude?: number; districtCode?: string },
>(data: T): data is T & SaveLocationInput {
  return (
    data.placeId !== undefined &&
    data.latitude !== undefined &&
    data.longitude !== undefined &&
    data.districtCode !== undefined
  );
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
    placeId?: string;
    latitude?: number;
    longitude?: number;
    districtCode?: string;
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

  const locationInput = locationFieldsPresent(data)
    ? {
        placeId: data.placeId,
        addressText: data.address,
        districtCode: data.districtCode,
        latitude: data.latitude,
        longitude: data.longitude,
      }
    : null;

  const {
    placeId: _placeId,
    latitude: _latitude,
    longitude: _longitude,
    districtCode: _districtCode,
    ...profileData
  } = data;
  const tutor = await prisma.tutor
    .create({ data: { accountId, ...profileData, phoneNumber: numbers.phoneNumber } })
    .catch((e: unknown) => mapContactNumberError(e, accountId, numbers));

  if (locationInput) {
    await upsertTutorLocation(tutor.id, locationInput);
  }

  return serializeTutor(tutor, await getTutorNeedsReaddress(tutor.id));
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
    placeId?: string;
    latitude?: number;
    longitude?: number;
    districtCode?: string;
  }>,
) {
  const existing = await prisma.tutor.findUnique({ where: { accountId } });
  if (!existing) return null;

  const numbers = { phoneNumber: data.phoneNumber, whatsappNumber: data.whatsappNumber };
  await assertContactNumbersFree(accountId, numbers);

  const locationInput = locationFieldsPresent(data)
    ? {
        placeId: data.placeId,
        addressText: data.address ?? existing.address,
        districtCode: data.districtCode,
        latitude: data.latitude,
        longitude: data.longitude,
      }
    : null;

  const {
    placeId: _placeId,
    latitude: _latitude,
    longitude: _longitude,
    districtCode: _districtCode,
    ...profileData
  } = data;
  const tutor = await prisma.tutor
    .update({ where: { accountId }, data: profileData })
    .catch((e: unknown) => mapContactNumberError(e, accountId, numbers));

  if (locationInput) {
    await upsertTutorLocation(tutor.id, locationInput);
  }

  return serializeTutor(tutor, await getTutorNeedsReaddress(tutor.id));
}

export async function replaceTutorAreas(accountId: string, areaIds: number[]) {
  const tutor = await prisma.tutor.findUnique({ where: { accountId } });
  if (!tutor) return null;

  await prisma.$transaction([
    prisma.tutorArea.deleteMany({ where: { tutorId: tutor.id } }),
    prisma.tutorArea.createMany({
      data: areaIds.map((areaId) => ({ tutorId: tutor.id, areaId })),
      skipDuplicates: true,
    }),
  ]);

  return prisma.tutorArea.findMany({
    where: { tutorId: tutor.id },
    include: { area: { select: { id: true, name: true } } },
  });
}

export async function replaceTutorSubjects(accountId: string, subjectIds: number[]) {
  const tutor = await prisma.tutor.findUnique({ where: { accountId } });
  if (!tutor) return null;

  await prisma.$transaction([
    prisma.tutorSubject.deleteMany({ where: { tutorId: tutor.id } }),
    prisma.tutorSubject.createMany({
      data: subjectIds.map((subjectId) => ({ tutorId: tutor.id, subjectId })),
      skipDuplicates: true,
    }),
  ]);

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
