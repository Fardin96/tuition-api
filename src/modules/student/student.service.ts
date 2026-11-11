import { assertContactNumbersFree, mapContactNumberError } from "../../lib/contact-numbers.js";
import { prisma } from "../../lib/prisma.js";
import {
  findOwnLocation,
  type OwnLocation,
  type SaveLocationInput,
  upsertLocation,
} from "../location/location.service.js";

function toNumber(value: unknown) {
  return Number(value);
}

function serializeStudent(
  student: {
    id: string;
    accountId: string;
    name: string;
    areaId: number;
    address: string;
    emergencyContact: string;
    phoneNumber: string;
    whatsappNumber: string;
    studentIdNumber: string;
    whatsappVerifiedAt: Date | null;
    verificationStatus: string;
    ratingAvg: unknown;
    ratingCount: number;
    createdAt: Date;
    updatedAt: Date;
  },
  location: OwnLocation | null,
) {
  return {
    ...student,
    ratingAvg: toNumber(student.ratingAvg),
    whatsappVerifiedAt: student.whatsappVerifiedAt?.toISOString() ?? null,
    location,
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
    phoneNumber?: string;
    whatsappNumber: string;
    studentIdNumber: string;
    location?: SaveLocationInput;
  },
) {
  const existing = await prisma.student.findUnique({ where: { accountId } });
  if (existing) {
    const err = new Error("Student profile already exists");
    Object.assign(err, { statusCode: 409 });
    throw err;
  }

  const numbers = {
    phoneNumber: data.phoneNumber ?? data.whatsappNumber,
    whatsappNumber: data.whatsappNumber,
  };
  await assertContactNumbersFree(accountId, numbers);

  const { location, ...profileData } = data;
  const student = await prisma.$transaction(async (tx) => {
    const created = await tx.student
      .create({ data: { accountId, ...profileData, phoneNumber: numbers.phoneNumber } })
      .catch((e: unknown) => mapContactNumberError(e, accountId, numbers));
    if (location) {
      await upsertLocation("student_location", created.id, location, tx);
    }
    return created;
  });

  return serializeStudent(student, await findOwnLocation("student_location", student.id));
}

export async function updateStudentProfile(
  accountId: string,
  data: Partial<{
    name: string;
    areaId: number;
    address: string;
    emergencyContact: string;
    phoneNumber: string;
    whatsappNumber: string;
    studentIdNumber: string;
    location?: SaveLocationInput;
  }>,
) {
  const existing = await prisma.student.findUnique({ where: { accountId } });
  if (!existing) return null;

  const numbers = { phoneNumber: data.phoneNumber, whatsappNumber: data.whatsappNumber };
  await assertContactNumbersFree(accountId, numbers);

  const { location, ...profileData } = data;
  const student = await prisma.$transaction(async (tx) => {
    const updated = await tx.student
      .update({ where: { accountId }, data: profileData })
      .catch((e: unknown) => mapContactNumberError(e, accountId, numbers));
    if (location) {
      await upsertLocation("student_location", updated.id, location, tx);
    }
    return updated;
  });

  return serializeStudent(student, await findOwnLocation("student_location", student.id));
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
