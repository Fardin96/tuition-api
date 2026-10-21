import crypto from "node:crypto";
import type { Role } from "../generated/prisma/enums.js";
import { prisma } from "../lib/prisma.js";
import { generateRefreshToken, hashToken, signAccessToken } from "../modules/auth/auth.service.js";
import { buildApp } from "../server.js";

export async function createTestApp() {
  return buildApp();
}

export async function createAccount(
  overrides: {
    role?: Role;
    email?: string;
    googleSub?: string;
    status?: "ACTIVE" | "BLOCKED" | "DELETED";
  } = {},
) {
  const role = overrides.role ?? "STUDENT";
  const email = overrides.email?.toLowerCase() ?? `test-${crypto.randomUUID()}@example.com`;
  const consent = role !== "ADMIN" ? { consentVersion: "v1", consentAcceptedAt: new Date() } : {};
  return prisma.account.create({
    data: {
      role,
      email,
      googleSub: overrides.googleSub ?? `google-${crypto.randomUUID()}`,
      status: overrides.status ?? "ACTIVE",
      ...consent,
    },
  });
}

export async function createSession(accountId: string) {
  const token = generateRefreshToken();
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30);
  await prisma.session.create({
    data: {
      accountId,
      refreshTokenHash: hashToken(token),
      expiresAt,
    },
  });
  return token;
}

export async function getAuthHeaders(account: { id: string; role: Role; email: string }) {
  const accessToken = await signAccessToken({
    accountId: account.id,
    role: account.role,
    email: account.email,
  });
  return { Authorization: `Bearer ${accessToken}` };
}

export async function createArea(
  overrides: { name?: string; district?: string; division?: string } = {},
) {
  return prisma.area.create({
    data: {
      division: overrides.division ?? "Dhaka",
      district: overrides.district ?? "Dhaka",
      name: overrides.name ?? `Area ${crypto.randomUUID()}`,
    },
  });
}

export async function createSubject(overrides: { name?: string } = {}) {
  return prisma.subject.create({
    data: {
      name: overrides.name ?? `Subject ${crypto.randomUUID()}`,
      slug: `subject-${crypto.randomUUID()}`,
    },
  });
}

export async function createCategory(overrides: { name?: string } = {}) {
  return prisma.category.create({
    data: {
      name: overrides.name ?? `Category ${crypto.randomUUID()}`,
      slug: `category-${crypto.randomUUID()}`,
    },
  });
}

export async function createRequirement(data: {
  studentId: string;
  categoryId: number;
  areaId: number;
  subjectId: number;
  classLevel?: number;
  timeOfDay?: Date;
  daysPerWeek?: number;
  salary?: number;
  hireByDate?: Date;
  tuitionType?: string;
}) {
  return prisma.tuitionRequirement.create({
    data: {
      classLevel: 10,
      timeOfDay: new Date("2024-01-01T10:00:00Z"),
      daysPerWeek: 3,
      salary: 5000,
      hireByDate: new Date("2024-12-31"),
      tuitionType: "HOME",
      ...data,
    },
  });
}

export async function createStudentProfile(
  accountId: string,
  areaId: number,
  overrides: {
    name?: string;
    address?: string;
    emergencyContact?: string;
    whatsappNumber?: string;
    studentIdNumber?: string;
  } = {},
) {
  return prisma.student.create({
    data: {
      accountId,
      areaId,
      name: overrides.name ?? "Test Student",
      address: overrides.address ?? "123 Test Lane",
      emergencyContact: overrides.emergencyContact ?? "+8801700000001",
      whatsappNumber:
        overrides.whatsappNumber ??
        `+88017${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`,
      studentIdNumber: overrides.studentIdNumber ?? `STU-${crypto.randomUUID()}`,
    },
  });
}

export async function createTutorProfile(
  accountId: string,
  overrides: {
    name?: string;
    address?: string;
    emergencyContact?: string;
    whatsappNumber?: string;
    studentIdNumber?: string;
    gender?: "MALE" | "FEMALE" | "OTHER";
    isListed?: boolean;
    verificationStatus?: "NOT_SUBMITTED" | "PENDING" | "APPROVED" | "REJECTED";
  } = {},
) {
  return prisma.tutor.create({
    data: {
      accountId,
      name: overrides.name ?? "Test Tutor",
      address: overrides.address ?? "456 Tutor Road",
      emergencyContact: overrides.emergencyContact ?? "+8801700000002",
      whatsappNumber:
        overrides.whatsappNumber ??
        `+88017${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`,
      studentIdNumber: overrides.studentIdNumber ?? `TUT-${crypto.randomUUID()}`,
      gender: overrides.gender ?? "MALE",
      isListed: overrides.isListed ?? false,
      verificationStatus:
        overrides.verificationStatus ?? (overrides.isListed ? "APPROVED" : "NOT_SUBMITTED"),
    },
  });
}

export async function createApplication(data: {
  requirementId?: string;
  packageId?: string;
  tutorId: string;
  studentId: string;
  initiatedBy: "TUTOR" | "STUDENT";
  status?:
    | "PENDING"
    | "CONFIRMED"
    | "COMPLETED"
    | "REJECTED"
    | "WITHDRAWN"
    | "CANCELLED"
    | "EXPIRED";
  confirmedAt?: Date;
  endedAt?: Date;
}) {
  if (!data.requirementId && !data.packageId) {
    throw new Error("Application requires a requirementId or packageId");
  }

  const status = data.status ?? "PENDING";
  const confirmedAt =
    data.confirmedAt ??
    (["CONFIRMED", "COMPLETED", "CANCELLED"].includes(status) ? new Date() : undefined);
  const endedAt = data.endedAt ?? (status === "COMPLETED" ? new Date() : undefined);

  return prisma.application.create({
    data: {
      ...data,
      status,
      confirmedAt,
      endedAt,
    },
  });
}

export async function createFileAsset(
  ownerAccountId: string,
  purpose: "STUDENT_ID" | "TUTOR_ID" | "CREDENTIAL" | "TUTOR_VIDEO",
) {
  return prisma.fileAsset.create({
    data: {
      ownerAccountId,
      purpose,
      storageKey: `test/${crypto.randomUUID()}`,
      contentType: "application/pdf",
      sizeBytes: 1024,
      status: "UPLOADED",
      uploadedAt: new Date(),
    },
  });
}
