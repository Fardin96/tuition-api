import { prisma } from "../../lib/prisma.js";
import { type SaveLocationInput, upsertStudentLocation } from "../location/location.service.js";

function toNumber(value: unknown) {
  return Number(value);
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

function compileLocationInput<T extends { address?: string | null }>(
  profileAddress: string,
  data: T & Partial<SaveLocationInput>,
): SaveLocationInput | null {
  if (!locationFieldsPresent(data)) return null;
  return {
    placeId: data.placeId,
    addressText: data.address ?? profileAddress,
    districtCode: data.districtCode,
    latitude: data.latitude,
    longitude: data.longitude,
  };
}

function serializeStudent(student: {
  id: string;
  accountId: string;
  name: string;
  areaId: number;
  address: string;
  emergencyContact: string;
  whatsappNumber: string;
  studentIdNumber: string;
  whatsappVerifiedAt: Date | null;
  verificationStatus: string;
  ratingAvg: unknown;
  ratingCount: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    ...student,
    ratingAvg: toNumber(student.ratingAvg),
    whatsappVerifiedAt: student.whatsappVerifiedAt?.toISOString() ?? null,
    createdAt: student.createdAt.toISOString(),
    updatedAt: student.updatedAt.toISOString(),
  };
}

export async function createStudentProfile(
  accountId: string,
  data: {
    name: string;
    areaId: number;
    address: string;
    emergencyContact: string;
    whatsappNumber: string;
    studentIdNumber: string;
    placeId?: string;
    latitude?: number;
    longitude?: number;
    districtCode?: string;
  },
) {
  const existing = await prisma.student.findUnique({ where: { accountId } });
  if (existing) {
    const err = new Error("Student profile already exists");
    Object.assign(err, { statusCode: 409 });
    throw err;
  }

  const {
    placeId: _placeId,
    latitude: _latitude,
    longitude: _longitude,
    districtCode: _districtCode,
    ...profileData
  } = data;
  const student = await prisma.student.create({
    data: { accountId, ...profileData },
  });

  const locationInput = compileLocationInput(student.address, data);
  if (locationInput) {
    await upsertStudentLocation(student.id, locationInput);
  }

  return serializeStudent(student);
}

export async function updateStudentProfile(
  accountId: string,
  data: Partial<{
    name: string;
    areaId: number;
    address: string;
    emergencyContact: string;
    whatsappNumber: string;
    studentIdNumber: string;
    placeId?: string;
    latitude?: number;
    longitude?: number;
    districtCode?: string;
  }>,
) {
  const existing = await prisma.student.findUnique({ where: { accountId } });
  if (!existing) return null;

  const {
    placeId: _placeId,
    latitude: _latitude,
    longitude: _longitude,
    districtCode: _districtCode,
    ...profileData
  } = data;
  const student = await prisma.student.update({
    where: { accountId },
    data: profileData,
  });

  const locationInput = compileLocationInput(student.address, data);
  if (locationInput) {
    await upsertStudentLocation(student.id, locationInput);
  }

  return serializeStudent(student);
}

export async function getStudentById(studentId: string) {
  const student = await prisma.student.findUnique({
    where: { id: studentId },
    include: { area: true },
  });
  if (!student) return null;
  return {
    id: student.id,
    name: student.name,
    area: { id: student.area.id, name: student.area.name },
    ratingAvg: toNumber(student.ratingAvg),
    ratingCount: student.ratingCount,
  };
}

export async function hasSharedApplication(tutorId: string, studentId: string) {
  const count = await prisma.application.count({
    where: { tutorId, studentId },
  });
  return count > 0;
}

export async function getStudentReviews(studentId: string) {
  return prisma.review.findMany({
    where: {
      studentId,
      direction: "TUTOR_TO_STUDENT",
      status: "VISIBLE",
    },
    orderBy: { createdAt: "desc" },
    include: { tutor: { select: { id: true, name: true } } },
  });
}
