import crypto from "node:crypto";
import type {
  AcademicGroup,
  AdmissionTarget,
  Curriculum,
  GenderPref,
  ListingStatus,
  Role,
} from "../generated/prisma/enums.js";
import { prisma } from "../lib/prisma.js";
import {
  type CreateSessionInput,
  GatewayError,
  type GatewayTransaction,
  type PaymentGateway,
} from "../lib/sslcommerz.js";
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
  overrides: { name?: string; district?: string; division?: string; isActive?: boolean } = {},
) {
  return prisma.area.create({
    data: {
      division: overrides.division ?? "Dhaka",
      district: overrides.district ?? "Dhaka",
      name: overrides.name ?? `Area ${crypto.randomUUID()}`,
      isActive: overrides.isActive ?? true,
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

export async function createRequirement(data: {
  studentId: string;
  areaId?: number;
  subjectId?: number;
  subjectIds?: number[];
  levelCode?: number | null;
  curriculum?: Curriculum | null;
  academicGroup?: AcademicGroup | null;
  admissionTargets?: AdmissionTarget[];
  isRetaker?: boolean;
  levelNote?: string | null;
  timeOfDay?: Date;
  daysPerWeek?: number;
  salary?: number;
  studentCount?: number;
  hireByDate?: Date;
  tutorGenderPref?: GenderPref;
  tuitionType?: string;
  status?: ListingStatus;
}) {
  const { subjectId, subjectIds, ...rest } = data;
  const sIds = subjectIds ?? (subjectId ? [subjectId] : []);
  return prisma.tuitionRequirement.create({
    data: {
      levelCode: 10,
      curriculum: "BANGLA_MEDIUM",
      timeOfDay: new Date("2024-01-01T10:00:00Z"),
      daysPerWeek: 3,
      salary: 5000,
      hireByDate: new Date("2024-12-31"),
      tuitionType: "Home Tutoring Solo",
      ...rest,
      subjects:
        sIds.length > 0
          ? {
              createMany: {
                data: sIds.map((id) => ({ subjectId: id })),
              },
            }
          : undefined,
    },
    include: { subjects: true },
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
    phoneNumber?: string;
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
      whatsappNumber: overrides.whatsappNumber ?? null,
      phoneNumber:
        overrides.phoneNumber ??
        `+88017${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`,
      studentIdNumber: overrides.studentIdNumber ?? `STU-${crypto.randomUUID()}`,
    },
  });
}

export async function createTutorProfile(
  accountId: string,
  overrides: {
    name?: string;
    instituteName?: string | null;
    address?: string;
    emergencyContact?: string;
    whatsappNumber?: string;
    phoneNumber?: string;
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
      instituteName: overrides.instituteName ?? null,
      address: overrides.address ?? "456 Tutor Road",
      emergencyContact: overrides.emergencyContact ?? "+8801700000002",
      whatsappNumber: overrides.whatsappNumber ?? null,
      phoneNumber:
        overrides.phoneNumber ??
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

export async function setTutorLocation(
  tutorId: string,
  data: {
    districtCode?: string;
    lat?: number;
    lng?: number;
    needsReaddress?: boolean;
    fetchedAt?: Date;
    geogSource?: "PIN" | "PLACES";
  } = {},
) {
  const placeId = `place-${tutorId}`;
  const district = data.districtCode ?? "dhaka";
  const lng = data.lng ?? 90.4125;
  const lat = data.lat ?? 23.8103;
  const fetchedAt = data.fetchedAt ?? new Date();
  const needsReaddress = data.needsReaddress ?? false;
  const geogSource = data.geogSource ?? "PLACES";

  await prisma.$executeRaw`
    INSERT INTO tutor_location (id, tutor_id, place_id, address_text, district_code, geog, geog_fetched_at, needs_readdress, updated_at, geog_source)
    VALUES (
      gen_random_uuid(),
      ${tutorId},
      ${placeId},
      'Tutor Address',
      ${district},
      ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography,
      ${fetchedAt},
      ${needsReaddress},
      NOW(),
      ${geogSource}::"GeogSource"
    );
  `;
}

export async function setStudentLocation(
  studentId: string,
  data: {
    districtCode?: string;
    lat?: number;
    lng?: number;
    needsReaddress?: boolean;
    fetchedAt?: Date;
    geogSource?: "PIN" | "PLACES";
  } = {},
) {
  const placeId = `place-${studentId}`;
  const district = data.districtCode ?? "dhaka";
  const lng = data.lng ?? 90.4125;
  const lat = data.lat ?? 23.8103;
  const fetchedAt = data.fetchedAt ?? new Date();
  const needsReaddress = data.needsReaddress ?? false;
  const geogSource = data.geogSource ?? "PLACES";

  await prisma.$executeRaw`
    INSERT INTO student_location (id, student_id, place_id, address_text, district_code, geog, geog_fetched_at, needs_readdress, updated_at, geog_source)
    VALUES (
      gen_random_uuid(),
      ${studentId},
      ${placeId},
      'Student Address',
      ${district},
      ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography,
      ${fetchedAt},
      ${needsReaddress},
      NOW(),
      ${geogSource}::"GeogSource"
    );
  `;
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

export async function createTutorZone(
  tutorId: string,
  overrides: { label?: string; lng?: number; lat?: number; radiusM?: number } = {},
) {
  const lng = overrides.lng ?? 90.4125;
  const lat = overrides.lat ?? 23.8103;
  const [zone] = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO tutor_zone (id, tutor_id, label, center, radius_m, geog_source, updated_at)
    VALUES (
      gen_random_uuid(),
      ${tutorId}::uuid,
      ${overrides.label ?? "Zone"},
      ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography,
      ${overrides.radiusM ?? 2000},
      'PIN'::"GeogSource",
      NOW()
    )
    RETURNING id;
  `;
  return zone.id;
}

export async function createTutorRequirement(
  tutorId: string,
  overrides: {
    name?: string;
    isDefault?: boolean;
    isActive?: boolean;
    subjectIds?: number[];
    zoneIds?: string[];
    levelMin?: number;
    levelMax?: number;
    curricula?: Curriculum[];
    academicGroups?: AcademicGroup[];
    admissionTargets?: AdmissionTarget[];
  } = {},
) {
  const requirement = await prisma.tutorRequirement.create({
    data: {
      tutorId,
      name: overrides.name ?? "Evening Math",
      isDefault: overrides.isDefault ?? false,
      isActive: overrides.isActive ?? true,
      levelMin: overrides.levelMin ?? 6,
      levelMax: overrides.levelMax ?? 10,
      curricula: overrides.curricula ?? ["BANGLA_MEDIUM", "ENGLISH_VERSION"],
      academicGroups: overrides.academicGroups ?? [],
      admissionTargets: overrides.admissionTargets ?? [],
      timeFrom: new Date("1970-01-01T10:00:00Z"),
      timeTo: new Date("1970-01-01T12:00:00Z"),
      availableFrom: new Date("2024-01-01"),
      teachesOnline: true,
    },
  });
  if (overrides.subjectIds?.length) {
    await prisma.tutorRequirementSubject.createMany({
      data: overrides.subjectIds.map((subjectId) => ({
        requirementId: requirement.id,
        tutorId,
        subjectId,
      })),
    });
  }
  if (overrides.zoneIds?.length) {
    await prisma.tutorRequirementZone.createMany({
      data: overrides.zoneIds.map((zoneId) => ({
        requirementId: requirement.id,
        tutorId,
        zoneId,
      })),
    });
  }
  return requirement;
}

// Defaults: one new subject (added to the tutor's profile), levels 6-10, Bangla medium, online.
// Subjects passed in are added to the profile too, since package_subject points at tutor_subject.
export async function createTuitionPackage(
  tutorId: string,
  overrides: {
    status?: ListingStatus;
    title?: string;
    price?: number;
    subjectIds?: number[];
    zoneIds?: string[];
    teachesOnline?: boolean;
    levelMin?: number;
    levelMax?: number;
    curricula?: Curriculum[];
    moderationStatus?: "PENDING" | "APPROVED" | "REJECTED";
    moderationNote?: string;
    createdAt?: Date;
  } = {},
) {
  const subjectIds = overrides.subjectIds ?? [(await createSubject()).id];
  await prisma.tutorSubject.createMany({
    data: subjectIds.map((subjectId) => ({ tutorId, subjectId })),
    skipDuplicates: true,
  });
  const zoneIds = overrides.zoneIds ?? [];
  return prisma.tuitionPackage.create({
    data: {
      tutorId,
      title: overrides.title ?? "SSC Math Booster",
      description: "Full syllabus revision with weekly tests.",
      coverage: "FULL_CURRICULUM",
      durationWeeks: 12,
      price: overrides.price ?? 15000,
      levelMin: overrides.levelMin ?? 6,
      levelMax: overrides.levelMax ?? 10,
      curricula: overrides.curricula ?? ["BANGLA_MEDIUM"],
      timeFrom: new Date("1970-01-01T10:00:00Z"),
      timeTo: new Date("1970-01-01T12:00:00Z"),
      daysPerWeek: 3,
      availableFrom: new Date("2024-01-01"),
      teachesOnline: overrides.teachesOnline ?? zoneIds.length === 0,
      status: overrides.status ?? "OPEN",
      moderationStatus: overrides.moderationStatus ?? "APPROVED",
      moderationNote: overrides.moderationNote ?? null,
      ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
      subjects: { create: subjectIds.map((subjectId) => ({ subjectId })) },
      zones: { create: zoneIds.map((zoneId) => ({ zoneId })) },
    },
  });
}

// admin_user CHECKs: an ACTIVE or REMOVED ADMIN needs an approving (and removing) super admin, and
// only allowlisted emails (super_admin_email, slots 1 and 2) can be SUPER_ADMIN.
async function createSuperAdminAccount() {
  const used = await prisma.superAdminEmail.findMany({ select: { slot: true } });
  const slot = [1, 2].find((n) => !used.some((row) => row.slot === n));
  if (!slot) throw new Error("Both super admin slots are taken");
  const email = `super-${crypto.randomUUID()}@example.com`;
  await prisma.superAdminEmail.create({ data: { slot, email } });
  const account = await createAccount({ role: "ADMIN", email });
  await prisma.adminUser.create({
    data: {
      accountId: account.id,
      name: "Test Super Admin",
      adminRole: "SUPER_ADMIN",
      status: "ACTIVE",
    },
  });
  return account;
}

// The active super admin, created on first use. Both slots can be filled, so reuse one when it exists.
export async function createSuperAdmin() {
  const existing = await prisma.adminUser.findFirst({
    where: { adminRole: "SUPER_ADMIN", status: "ACTIVE" },
    select: { account: true },
  });
  return existing?.account ?? createSuperAdminAccount();
}

// A placement fee on a CONFIRMED application. Status and amountPaid move only through fee_payment rows.
export async function createPlatformFee(data: {
  tutorId: string;
  applicationId: string;
  amountDue?: number;
  dueDate?: Date;
  feeType?: "PLACEMENT" | "RECURRING" | "OTHER";
  status?: "DUE" | "WAIVED" | "VOID";
}) {
  return prisma.platformFee.create({
    data: {
      tutorId: data.tutorId,
      applicationId: data.applicationId,
      feeType: data.feeType ?? "PLACEMENT",
      amountDue: data.amountDue ?? 1500,
      dueDate: data.dueDate ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      status: data.status ?? "DUE",
    },
  });
}

// Records a payment through the ledger (the trigger updates amount_paid and status).
export async function createFeePayment(data: {
  feeId: string;
  amount: number;
  recordedById: string;
  kind?: "PAYMENT" | "REVERSAL";
  reversesPaymentId?: string;
  reason?: string;
}) {
  return prisma.feePayment.create({
    data: {
      feeId: data.feeId,
      amount: data.amount,
      method: "CASH",
      kind: data.kind ?? "PAYMENT",
      reversesPaymentId: data.reversesPaymentId ?? null,
      reason: data.reason ?? null,
      receivedAt: new Date(),
      recordedById: data.recordedById,
    },
  });
}

export async function createAdmin(
  overrides: {
    status?: "PENDING" | "ACTIVE" | "REMOVED";
    adminRole?: "ADMIN" | "SUPER_ADMIN";
  } = {},
) {
  if (overrides.adminRole === "SUPER_ADMIN") return createSuperAdminAccount();

  const status = overrides.status ?? "ACTIVE";
  const existing = await prisma.adminUser.findFirst({
    where: { adminRole: "SUPER_ADMIN", status: "ACTIVE" },
    select: { accountId: true },
  });
  const approverId = existing?.accountId ?? (await createSuperAdminAccount()).id;
  const now = new Date();
  const account = await createAccount({ role: "ADMIN" });
  await prisma.adminUser.create({
    data: {
      accountId: account.id,
      name: "Test Admin",
      adminRole: "ADMIN",
      status,
      ...(status !== "PENDING" ? { approvedById: approverId, approvedAt: now } : {}),
      ...(status === "REMOVED" ? { removedById: approverId, removedAt: now } : {}),
    },
  });
  return account;
}

export async function createZoneLimitRequest(
  tutorId: string,
  overrides: {
    requestedLimit?: number;
    reason?: string;
    status?: "PENDING" | "APPROVED" | "DENIED";
    decidedById?: string;
    createdAt?: Date;
  } = {},
) {
  const status = overrides.status ?? "PENDING";
  const decided = status !== "PENDING";
  return prisma.zoneLimitRequest.create({
    data: {
      tutorId,
      requestedLimit: overrides.requestedLimit ?? 10,
      reason: overrides.reason ?? "I teach across several neighbourhoods",
      status,
      decidedById: decided ? overrides.decidedById : null,
      decidedAt: decided ? new Date() : null,
      ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
    },
  });
}

// In-memory SSLCommerz stand-in. Tests drive it with setValidation, setQuery and failNext.
export function createFakeGateway() {
  const sessions: CreateSessionInput[] = [];
  const validations = new Map<string, GatewayTransaction>();
  const queries = new Map<string, GatewayTransaction[]>();
  let nextFailure: GatewayError["kind"] | null = null;

  const maybeFail = () => {
    if (!nextFailure) return;
    const kind = nextFailure;
    nextFailure = null;
    throw new GatewayError(kind, `Fake gateway ${kind}`);
  };

  const gateway: PaymentGateway = {
    async createSession(input) {
      maybeFail();
      sessions.push(input);
      return {
        sessionKey: `SK-${input.tranId}`,
        gatewayUrl: `https://sandbox.sslcommerz.com/EasyCheckOut/test${input.tranId}`,
      };
    },
    async validate(valId) {
      maybeFail();
      return (
        validations.get(valId) ?? {
          status: "INVALID_TRANSACTION",
          tranId: "",
          valId,
          amount: "0.00",
          currencyType: "BDT",
          currencyAmount: "0.00",
          bankTranId: null,
          cardType: null,
          riskLevel: null,
          riskTitle: null,
          raw: {},
        }
      );
    },
    async queryByTranId(tranId) {
      maybeFail();
      return [...(queries.get(tranId) ?? [])];
    },
  };

  return {
    gateway,
    sessions,
    setValidation(valId: string, tx: GatewayTransaction) {
      validations.set(valId, tx);
    },
    setQuery(tranId: string, txs: GatewayTransaction[]) {
      queries.set(tranId, txs);
    },
    failNext(kind: GatewayError["kind"]) {
      nextFailure = kind;
    },
  };
}

export function fakeSuccess({
  tranId,
  valId,
  amount,
}: {
  tranId: string;
  valId: string;
  amount: string;
}): GatewayTransaction {
  return {
    status: "VALID",
    tranId,
    valId,
    amount,
    currencyType: "BDT",
    currencyAmount: amount,
    bankTranId: `BANK-${valId}`,
    cardType: "VISA",
    riskLevel: 0,
    riskTitle: "Safe",
    raw: {
      status: "VALID",
      tran_id: tranId,
      val_id: valId,
      amount,
      currency_type: "BDT",
      currency_amount: amount,
      risk_level: "0",
    },
  };
}

// A tutor with a CONFIRMED requirement application and a placement fee of amountDue, ready to pay.
export async function createTutorFeeFixture(amountDue = 1500) {
  const area = await createArea();
  const studentAccount = await createAccount({ role: "STUDENT" });
  const student = await createStudentProfile(studentAccount.id, area.id);
  const tutorAccount = await createAccount({ role: "TUTOR" });
  const tutor = await createTutorProfile(tutorAccount.id);
  const requirement = await createRequirement({ studentId: student.id });
  const application = await createApplication({
    requirementId: requirement.id,
    tutorId: tutor.id,
    studentId: student.id,
    initiatedBy: "TUTOR",
    status: "CONFIRMED",
  });
  const fee = await createPlatformFee({
    tutorId: tutor.id,
    applicationId: application.id,
    amountDue,
  });
  return {
    studentAccount,
    student,
    tutorAccount,
    tutor,
    tutorHeaders: await getAuthHeaders(tutorAccount),
    application,
    fee,
  };
}

// Upserts one platform_setting row. The value is JSON, so booleans and numbers are kept as they are.
export async function setPlatformSetting(key: string, value: boolean | number | string) {
  await prisma.platformSetting.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  });
}
