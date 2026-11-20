import crypto from "node:crypto";
import { env } from "../../config/env.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { assertContactNumbersFree, mapContactNumberError } from "../../lib/contact-numbers.js";
import { appError } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { sendSms } from "../../lib/sms.js";
import type { AuthContext } from "../auth/auth.schema.js";
import { findLatestVerifiedOtp, isPhoneVerificationRequired } from "./phone-verification.policy.js";
import type {
  PhoneOtpSentResponse,
  PhoneVerificationStatusResponse,
  PhoneVerifiedResponse,
  SendPhoneOtpInput,
  VerifyPhoneOtpInput,
} from "./phone-verification.schema.js";

export const OTP_TTL_MS = 5 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_COOLDOWN_MS = 60 * 1000;
export const OTP_PHONE_HOURLY_LIMIT = 5;
export const OTP_ACCOUNT_HOURLY_LIMIT = 10;
const HOUR_MS = 60 * 60 * 1000;

type Db = Prisma.TransactionClient | typeof prisma;
type PhoneRole = "STUDENT" | "TUTOR";
type Profile = { phoneNumber: string; phoneVerifiedAt: Date | null };

// Admins have no profile and no phone verification; the routes already refuse them.
function phoneRoleOf(account: AuthContext): PhoneRole {
  if (account.role === "STUDENT" || account.role === "TUTOR") return account.role;
  throw appError("Forbidden", 403, "Forbidden");
}

async function findProfile(db: Db, role: PhoneRole, accountId: string): Promise<Profile | null> {
  const select = { phoneNumber: true, phoneVerifiedAt: true } as const;
  if (role === "STUDENT") {
    return db.student.findUnique({ where: { accountId }, select });
  }
  return db.tutor.findUnique({ where: { accountId }, select });
}

// The access token check already refuses blocked accounts on every request; this guards the OTP
// routes themselves so a sent code or a verify attempt never runs for a non-active account.
async function assertAccountActive(accountId: string) {
  const row = await prisma.account.findUnique({
    where: { id: accountId },
    select: { status: true },
  });
  if (row?.status !== "ACTIVE") {
    throw appError("Forbidden", 403, "Account is blocked");
  }
}

// Writes the profile's phone and its verification time in one UPDATE. The phone_verified_reset
// trigger clears verified_at on a phone change only when verified_at is left unchanged, so this
// keeps the new timestamp.
async function writeProfilePhone(
  tx: Prisma.TransactionClient,
  role: PhoneRole,
  accountId: string,
  data: { phoneNumber: string; phoneVerifiedAt: Date },
) {
  if (role === "STUDENT") {
    await tx.student.update({ where: { accountId }, data });
  } else {
    await tx.tutor.update({ where: { accountId }, data });
  }
}

// HMAC keyed by the access token secret, bound to the row id so one code cannot be replayed on another row.
function hashCode(otpId: string, code: string) {
  return crypto
    .createHmac("sha256", env.ACCESS_TOKEN_SECRET)
    .update(`${otpId}:${code}`)
    .digest("hex");
}

function codeMatches(otpId: string, code: string, storedHash: string) {
  const expected = Buffer.from(hashCode(otpId, code), "hex");
  const stored = Buffer.from(storedHash, "hex");
  return expected.length === stored.length && crypto.timingSafeEqual(expected, stored);
}

function newCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

// Serialises sends for one account and one number, so two requests at once cannot both pass the
// cooldown or the caps. Taken in the same order everywhere (account, then phone).
async function lockSends(tx: Prisma.TransactionClient, accountId: string, phoneNumber: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`phone-otp-account:${accountId}`}))::text`;
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`phone-otp-phone:${phoneNumber}`}))::text`;
}

async function assertSendAllowed(
  tx: Prisma.TransactionClient,
  accountId: string,
  phoneNumber: string,
  now: Date,
) {
  const last = await tx.phoneOtp.findFirst({
    where: { accountId, phoneNumber },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  if (last && now.getTime() - last.createdAt.getTime() < OTP_COOLDOWN_MS) {
    const retryAfterSeconds = Math.ceil(
      (last.createdAt.getTime() + OTP_COOLDOWN_MS - now.getTime()) / 1000,
    );
    throw appError(
      "OtpCooldown",
      429,
      `Wait ${retryAfterSeconds} seconds before requesting another code.`,
      { retryAfterSeconds },
    );
  }

  // Rows count even when the SMS failed, so a failing provider cannot be hammered.
  const since = new Date(now.getTime() - HOUR_MS);
  const toPhone = await tx.phoneOtp.count({
    where: { phoneNumber, createdAt: { gt: since } },
  });
  if (toPhone >= OTP_PHONE_HOURLY_LIMIT) {
    throw appError("OtpSendLimit", 429, "Too many codes sent to this number. Try again later.");
  }
  const fromAccount = await tx.phoneOtp.count({
    where: { accountId, createdAt: { gt: since } },
  });
  if (fromAccount >= OTP_ACCOUNT_HOURLY_LIMIT) {
    throw appError("OtpSendLimit", 429, "Too many codes requested. Try again later.");
  }
}

export async function getPhoneVerificationStatus(
  account: AuthContext,
): Promise<PhoneVerificationStatusResponse> {
  const role = phoneRoleOf(account);
  const required = await isPhoneVerificationRequired(role);
  const profile = await findProfile(prisma, role, account.accountId);
  const pending = profile ? null : await findLatestVerifiedOtp(prisma, account.accountId);
  return {
    required,
    phoneNumber: profile?.phoneNumber ?? null,
    verifiedAt: profile?.phoneVerifiedAt ?? null,
    pendingVerification: pending
      ? { phoneNumber: pending.phoneNumber, verifiedAt: pending.verifiedAt }
      : null,
  };
}

export async function sendPhoneOtp(
  account: AuthContext,
  input: SendPhoneOtpInput,
): Promise<PhoneOtpSentResponse> {
  const role = phoneRoleOf(account);
  const { accountId } = account;
  const { phoneNumber } = input;

  await assertAccountActive(accountId);
  await assertContactNumbersFree(accountId, { phoneNumber });
  const profile = await findProfile(prisma, role, accountId);
  if (profile?.phoneNumber === phoneNumber && profile.phoneVerifiedAt) {
    throw appError("PhoneAlreadyVerified", 409, "This number is already verified.");
  }

  const otpId = crypto.randomUUID();
  const code = newCode();
  const row = await prisma.$transaction(async (tx) => {
    await lockSends(tx, accountId, phoneNumber);
    const now = new Date();
    await assertSendAllowed(tx, accountId, phoneNumber, now);
    return tx.phoneOtp.create({
      data: {
        id: otpId,
        accountId,
        phoneNumber,
        codeHash: hashCode(otpId, code),
        expiresAt: new Date(now.getTime() + OTP_TTL_MS),
        createdAt: now,
      },
      select: { id: true, expiresAt: true, createdAt: true },
    });
  });

  try {
    const sent = await sendSms(
      phoneNumber,
      `Your Masters Hub code is ${code}. It expires in 5 minutes. Don't share it with anyone.`,
    );
    // Codes sent earlier for this number stop working once the new one is out. A failed send
    // leaves them alone, so the user can still type a code they already received.
    await prisma.phoneOtp.updateMany({
      where: {
        accountId,
        phoneNumber,
        verifiedAt: null,
        expiresAt: { gt: new Date() },
        id: { not: row.id },
      },
      data: { expiresAt: new Date() },
    });
    if (sent.requestId) {
      await prisma.phoneOtp.update({
        where: { id: row.id },
        data: { providerRequestId: sent.requestId },
      });
    }
  } catch (err) {
    // The code never reached the phone, so it must not verify. The row stays for the cooldown and caps.
    await prisma.phoneOtp.updateMany({
      where: { id: row.id },
      data: { expiresAt: new Date() },
    });
    throw err;
  }

  return {
    phoneNumber,
    expiresAt: row.expiresAt,
    resendAfter: new Date(row.createdAt.getTime() + OTP_COOLDOWN_MS),
  };
}

export async function verifyPhoneOtp(
  account: AuthContext,
  input: VerifyPhoneOtpInput,
): Promise<PhoneVerifiedResponse> {
  const role = phoneRoleOf(account);
  const { accountId } = account;
  const { phoneNumber, code } = input;

  await assertAccountActive(accountId);
  const otp = await prisma.phoneOtp.findFirst({
    // The latest live code: a newer row whose SMS failed is already expired and is skipped.
    where: {
      accountId,
      phoneNumber,
      verifiedAt: null,
      consumedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, codeHash: true, expiresAt: true },
  });
  if (!otp || otp.expiresAt.getTime() <= Date.now()) {
    throw appError("OtpExpired", 400, "This code has expired. Send a new one.");
  }

  // The increment is the guard: a row at the limit is not updated, so parallel guesses cannot
  // slip past it.
  const bumped = await prisma.$queryRaw<{ attempts: number }[]>`
    UPDATE phone_otp SET attempts = attempts + 1
    WHERE id = ${otp.id}::uuid AND attempts < ${OTP_MAX_ATTEMPTS}
    RETURNING attempts`;
  if (bumped.length === 0) {
    throw appError("OtpTooManyAttempts", 429, "Too many wrong codes. Send a new one.");
  }

  if (!codeMatches(otp.id, code, otp.codeHash)) {
    throw appError("OtpInvalid", 400, "That code isn't right. Check the SMS and try again.", {
      attemptsLeft: OTP_MAX_ATTEMPTS - bumped[0].attempts,
    });
  }

  const profile = await findProfile(prisma, role, accountId);
  if (profile && profile.phoneNumber !== phoneNumber) {
    await assertContactNumbersFree(accountId, { phoneNumber });
  }

  const verifiedAt = new Date();
  await prisma.$transaction(async (tx) => {
    const current = await findProfile(tx, role, accountId);
    // A profile existing now is what decides whether the code is spent here or kept for sign-up.
    const { count } = await tx.phoneOtp.updateMany({
      where: { id: otp.id, verifiedAt: null, consumedAt: null },
      data: { verifiedAt, consumedAt: current ? verifiedAt : null },
    });
    if (count !== 1) {
      throw appError("OtpExpired", 400, "This code has expired. Send a new one.");
    }
    if (current) {
      await writeProfilePhone(tx, role, accountId, {
        phoneNumber,
        phoneVerifiedAt: verifiedAt,
      }).catch((e: unknown) => mapContactNumberError(e, accountId, { phoneNumber }));
    }
  });

  return { phoneNumber, verifiedAt };
}
