import type { Prisma } from "../../generated/prisma/client.js";
import { appError } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";

type Db = Prisma.TransactionClient | typeof prisma;

const SETTING_KEYS = {
  STUDENT: "require_student_phone_verification",
  TUTOR: "require_tutor_phone_verification",
} as const;

// A verified code counts for sign-up only this long after it was verified.
export const VERIFIED_OTP_WINDOW_MS = 30 * 60 * 1000;

// Defaults to false when the platform_setting row is missing.
export async function isPhoneVerificationRequired(
  role: "STUDENT" | "TUTOR",
  db: Db = prisma,
): Promise<boolean> {
  const row = await db.platformSetting.findUnique({
    where: { key: SETTING_KEYS[role] },
    select: { value: true },
  });
  return row?.value === true;
}

// The latest code this account verified for this number that has not been used by a profile yet.
export async function findVerifiedOtp(
  db: Db,
  accountId: string,
  phoneNumber: string,
): Promise<{ id: string; verifiedAt: Date } | null> {
  const since = new Date(Date.now() - VERIFIED_OTP_WINDOW_MS);
  const row = await db.phoneOtp.findFirst({
    where: {
      accountId,
      phoneNumber,
      consumedAt: null,
      verifiedAt: { gte: since },
    },
    orderBy: [{ verifiedAt: "desc" }, { createdAt: "desc" }],
    select: { id: true, verifiedAt: true },
  });
  if (!row?.verifiedAt) return null;
  return { id: row.id, verifiedAt: row.verifiedAt };
}

// Same pick as findVerifiedOtp, but for any number: the latest verified code this account has not
// spent, so onboarding can resume after a reload.
export async function findLatestVerifiedOtp(
  db: Db,
  accountId: string,
): Promise<{ id: string; phoneNumber: string; verifiedAt: Date } | null> {
  const since = new Date(Date.now() - VERIFIED_OTP_WINDOW_MS);
  const row = await db.phoneOtp.findFirst({
    where: { accountId, consumedAt: null, verifiedAt: { gte: since } },
    orderBy: [{ verifiedAt: "desc" }, { createdAt: "desc" }],
    select: { id: true, phoneNumber: true, verifiedAt: true },
  });
  if (!row?.verifiedAt) return null;
  return { id: row.id, phoneNumber: row.phoneNumber, verifiedAt: row.verifiedAt };
}

// Marks the code used. Guarded so a code can only be spent once; the caller's transaction rolls
// back when another request spent it first.
export async function consumeOtp(db: Db, id: string): Promise<void> {
  const { count } = await db.phoneOtp.updateMany({
    where: { id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  if (count !== 1) {
    throw appError(
      "PhoneVerificationRequired",
      403,
      "Verify your phone number to finish signing up.",
    );
  }
}

// Listing and placement gate: the profile must have a verified phone when the admin switch is on.
export async function assertPhoneVerified(
  db: Db,
  role: "STUDENT" | "TUTOR",
  profileId: string,
  message: string,
): Promise<void> {
  if (!(await isPhoneVerificationRequired(role, db))) return;
  const profile =
    role === "STUDENT"
      ? await db.student.findUnique({ where: { id: profileId }, select: { phoneVerifiedAt: true } })
      : await db.tutor.findUnique({ where: { id: profileId }, select: { phoneVerifiedAt: true } });
  if (profile?.phoneVerifiedAt) return;
  throw appError("PhoneVerificationRequired", 403, message);
}

// Sign-up gate. Returns the verified code to spend, or null when none is needed.
export async function assertPhoneVerifiedForSignup(
  db: Db,
  role: "STUDENT" | "TUTOR",
  accountId: string,
  phoneNumber: string,
): Promise<{ id: string; verifiedAt: Date } | null> {
  const otp = await findVerifiedOtp(db, accountId, phoneNumber);
  if (otp) return otp;
  if (await isPhoneVerificationRequired(role, db)) {
    throw appError(
      "PhoneVerificationRequired",
      403,
      "Verify your phone number to finish signing up.",
    );
  }
  return null;
}
