import { unusableAreaIds } from "../../lib/areas.js";
import { assertContactNumbersFree, mapContactNumberError } from "../../lib/contact-numbers.js";
import { appError, notFound } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { claimFile } from "../files/files.service.js";
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
    whatsappNumber: string | null;
    studentIdNumber: string;
    whatsappVerifiedAt: Date | null;
    verificationStatus: string;
    verificationNote: string | null;
    verificationSubmittedAt: Date | null;
    verificationDecidedAt: Date | null;
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
    verificationSubmittedAt: student.verificationSubmittedAt?.toISOString() ?? null,
    verificationDecidedAt: student.verificationDecidedAt?.toISOString() ?? null,
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
    phoneNumber: string;
    whatsappNumber?: string | null;
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

  const unusable = await unusableAreaIds(prisma, [data.areaId]);
  if (unusable.length > 0) {
    throw appError("ValidationError", 400, "Unknown area", { areaIds: [data.areaId] });
  }

  const numbers = { phoneNumber: data.phoneNumber, whatsappNumber: data.whatsappNumber };
  await assertContactNumbersFree(accountId, numbers);

  const { location, ...profileData } = data;
  const student = await prisma.$transaction(async (tx) => {
    const created = await tx.student
      .create({ data: { accountId, ...profileData } })
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
    whatsappNumber: string | null;
    studentIdNumber: string;
    location?: SaveLocationInput;
  }>,
) {
  const existing = await prisma.student.findUnique({ where: { accountId } });
  if (!existing) return null;

  // An area the student already has may be inactive; only a newly chosen one is checked.
  if (data.areaId !== undefined && data.areaId !== existing.areaId) {
    const unusable = await unusableAreaIds(prisma, [data.areaId]);
    if (unusable.length > 0) {
      throw appError("ValidationError", 400, "Unknown area", { areaIds: [data.areaId] });
    }
  }

  const numbers = { phoneNumber: data.phoneNumber, whatsappNumber: data.whatsappNumber };
  await assertContactNumbersFree(accountId, numbers);

  const { location, ...profileData } = data;
  const whatsappChanged =
    data.whatsappNumber !== undefined && data.whatsappNumber !== existing.whatsappNumber;
  const student = await prisma.$transaction(async (tx) => {
    const updated = await tx.student
      .update({
        where: { accountId },
        data: whatsappChanged ? { ...profileData, whatsappVerifiedAt: null } : profileData,
      })
      .catch((e: unknown) => mapContactNumberError(e, accountId, numbers));
    if (location) {
      await upsertLocation("student_location", updated.id, location, tx);
    }
    return updated;
  });

  return serializeStudent(student, await findOwnLocation("student_location", student.id));
}

// Sends the ID for review. Allowed when nothing is pending or approved (NOT_SUBMITTED or REJECTED).
// The previous file stays until the cleanup cron removes it.
export async function submitStudentVerification(accountId: string, fileId: string) {
  const found = await prisma.student.findUnique({ where: { accountId }, select: { id: true } });
  if (!found) throw notFound("Student profile not found");

  const student = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM student WHERE id = ${found.id}::uuid FOR UPDATE`;
    const row = await tx.student.findUniqueOrThrow({ where: { id: found.id } });
    if (row.verificationStatus === "PENDING" || row.verificationStatus === "APPROVED") {
      throw appError(
        "InvalidVerificationState",
        409,
        row.verificationStatus === "PENDING"
          ? "Your ID is already under review."
          : "Your ID is already verified.",
      );
    }
    await claimFile(tx, { fileId, ownerAccountId: accountId, purpose: "STUDENT_ID" });
    return tx.student.update({
      where: { id: found.id },
      data: {
        verificationFileId: fileId,
        verificationStatus: "PENDING",
        verificationSubmittedAt: new Date(),
        verificationDecidedAt: null,
        verificationReviewedById: null,
        verificationNote: null,
      },
    });
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
