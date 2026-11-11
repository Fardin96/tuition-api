import crypto from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { env } from "../../config/env.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { Role } from "../../generated/prisma/enums.js";
import type { AccountModel } from "../../generated/prisma/models/Account.js";
import { isNumberUsedByOtherAccount } from "../../lib/contact-numbers.js";
import { prisma } from "../../lib/prisma.js";
import { findOwnLocation } from "../location/location.service.js";

const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const GOOGLE_JWKS_URI = "https://www.googleapis.com/oauth2/v3/certs";

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks() {
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URI));
  }
  return jwks;
}

export type GoogleTokenPayload = {
  sub: string;
  email: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
};

export async function verifyGoogleIdToken(idToken: string): Promise<GoogleTokenPayload> {
  if (!env.GOOGLE_CLIENT_ID) {
    throw new Error("GOOGLE_CLIENT_ID is not configured");
  }
  const { payload } = await jwtVerify(idToken, getJwks(), {
    issuer: GOOGLE_ISSUERS,
    audience: env.GOOGLE_CLIENT_ID,
  });
  if (!payload.sub || !payload.email) {
    throw new Error("Invalid Google token: missing sub or email");
  }
  return {
    sub: payload.sub as string,
    email: (payload.email as string).toLowerCase(),
    email_verified: payload.email_verified as boolean | undefined,
    name: payload.name as string | undefined,
    picture: payload.picture as string | undefined,
  };
}

export type AccessTokenPayload = {
  accountId: string;
  role: Role;
  email: string;
};

export async function signAccessToken(payload: AccessTokenPayload): Promise<string> {
  const { SignJWT } = await import("jose");
  const secret = new TextEncoder().encode(env.ACCESS_TOKEN_SECRET);
  return new SignJWT({ ...payload, type: "access" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(env.ACCESS_TOKEN_TTL)
    .sign(secret);
}

export async function verifyAccessToken(token: string): Promise<AccessTokenPayload> {
  const { jwtVerify: localJwtVerify } = await import("jose");
  const secret = new TextEncoder().encode(env.ACCESS_TOKEN_SECRET);
  const { payload } = await localJwtVerify(token, secret, {
    algorithms: ["HS256"],
  });
  if (payload.type !== "access") {
    throw new Error("Invalid token type");
  }
  // Checked per request so a block or self-delete takes effect before the token expires.
  const account = await prisma.account.findUnique({
    where: { id: payload.accountId as string },
    select: { status: true },
  });
  if (account?.status !== "ACTIVE") {
    throw new Error("Account is not active");
  }
  return {
    accountId: payload.accountId as string,
    role: payload.role as Role,
    email: payload.email as string,
  };
}

export function generateRefreshToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function createSession(
  accountId: string,
  refreshToken: string,
  meta?: { ip?: string; userAgent?: string },
) {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30); // 30 days
  return prisma.session.create({
    data: {
      accountId,
      refreshTokenHash: hashToken(refreshToken),
      expiresAt,
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
    },
  });
}

export async function rotateRefreshToken(
  oldToken: string,
  meta?: { ip?: string; userAgent?: string },
) {
  const oldHash = hashToken(oldToken);
  const session = await prisma.session.findUnique({
    where: { refreshTokenHash: oldHash },
    include: { account: true },
  });
  if (
    !session ||
    session.revokedAt ||
    session.expiresAt < new Date() ||
    session.account.status !== "ACTIVE"
  ) {
    throw new Error("Invalid or expired refresh token");
  }

  const newToken = generateRefreshToken();
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30);

  await prisma.session.update({
    where: { id: session.id },
    data: { revokedAt: new Date() },
  });

  const newSession = await prisma.session.create({
    data: {
      accountId: session.accountId,
      refreshTokenHash: hashToken(newToken),
      expiresAt,
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
    },
  });

  return { newToken, account: session.account, session: newSession };
}

export async function revokeSessionByToken(token: string) {
  const hash = hashToken(token);
  return prisma.session.updateMany({
    where: { refreshTokenHash: hash },
    data: { revokedAt: new Date() },
  });
}

export async function revokeAllSessions(accountId: string, exceptSessionId?: string) {
  return prisma.session.updateMany({
    where: {
      accountId,
      revokedAt: null,
      ...(exceptSessionId ? { NOT: { id: exceptSessionId } } : {}),
    },
    data: { revokedAt: new Date() },
  });
}

export async function revokeSessionById(accountId: string, sessionId: string) {
  const session = await prisma.session.findFirst({
    where: { id: sessionId, accountId },
  });
  if (!session) return null;
  return prisma.session.update({
    where: { id: sessionId },
    data: { revokedAt: new Date() },
  });
}

export async function listSessions(accountId: string) {
  return prisma.session.findMany({
    where: { accountId, revokedAt: null },
    orderBy: { lastUsedAt: "desc" },
    select: {
      id: true,
      createdAt: true,
      lastUsedAt: true,
      expiresAt: true,
      ip: true,
      userAgent: true,
    },
  });
}

export async function findAccountByGoogleSub(googleSub: string) {
  return prisma.account.findUnique({
    where: { googleSub },
  });
}

function tombstone(accountId: string, number: string) {
  const prefix = `deleted:${accountId}:`;
  return number.startsWith(prefix) ? number : `${prefix}${number}`;
}

// A number another account has since taken stays tombstoned instead of failing sign-up.
async function restoreNumber(accountId: string, value: string) {
  const prefix = `deleted:${accountId}:`;
  if (!value.startsWith(prefix)) return value;
  const original = value.slice(prefix.length);
  return (await isNumberUsedByOtherAccount(accountId, original)) ? value : original;
}

async function reactivateAccount(accountId: string) {
  const account = await prisma.account.findUniqueOrThrow({
    where: { id: accountId },
    include: { student: true, tutor: true },
  });
  return prisma.$transaction(async (tx) => {
    if (account.student) {
      await tx.student.update({
        where: { id: account.student.id },
        data: {
          phoneNumber: await restoreNumber(accountId, account.student.phoneNumber),
          whatsappNumber: await restoreNumber(accountId, account.student.whatsappNumber),
        },
      });
    }
    if (account.tutor) {
      await tx.tutor.update({
        where: { id: account.tutor.id },
        data: {
          phoneNumber: await restoreNumber(accountId, account.tutor.phoneNumber),
          whatsappNumber: await restoreNumber(accountId, account.tutor.whatsappNumber),
        },
      });
    }
    return tx.account.update({
      where: { id: accountId },
      data: { status: "ACTIVE", deletedAt: null, lastLoginAt: new Date() },
    });
  });
}

export async function createOrUpdateAccount(
  payload: GoogleTokenPayload,
  role: Role | undefined,
  consentVersion?: string,
): Promise<{ account: AccountModel; isNew: boolean }> {
  const existing = await prisma.account.findUnique({
    where: { googleSub: payload.sub },
  });

  if (existing) {
    // Blocks are checked on sign-in and sign-up alike; a DELETED account can still carry an open block.
    const deleted = existing.status === "DELETED";
    const openBlock = deleted
      ? await prisma.accountBlock.findFirst({
          where: { accountId: existing.id, unblockedAt: null },
          select: { id: true },
        })
      : null;
    if (existing.status === "BLOCKED" || openBlock) {
      throw Object.assign(new Error("Account is blocked"), { statusCode: 403 });
    }
    if (deleted && !role) {
      throw Object.assign(new Error("Account was deleted. Sign up to reactivate it."), {
        statusCode: 403,
      });
    }
    if (deleted) {
      return { account: await reactivateAccount(existing.id), isNew: false };
    }
    const account = await prisma.account.update({
      where: { id: existing.id },
      data: { lastLoginAt: new Date() },
    });
    return { account, isNew: false };
  }

  if (!role) {
    const err = new Error("No account found for this Google account. Sign up first.");
    Object.assign(err, { statusCode: 404 });
    throw err;
  }

  const isSuperAdmin = await prisma.superAdminEmail.findUnique({
    where: { email: payload.email },
  });
  const adminRole = isSuperAdmin ? "SUPER_ADMIN" : "ADMIN";

  // DB constraint account_consent_recorded requires non-admin accounts to have
  // both consent fields set. Default to a version if the frontend didn't send one.
  // ponytail: consent is bundled into sign-up; split it out if legal needs explicit opt-in flow.
  const consent =
    role !== "ADMIN"
      ? {
          consentVersion: consentVersion ?? "v1",
          consentAcceptedAt: new Date(),
        }
      : {};

  const account = await prisma.account.create({
    data: {
      role,
      googleSub: payload.sub,
      email: payload.email,
      status: "ACTIVE",
      lastLoginAt: new Date(),
      ...consent,
      ...(role === "ADMIN"
        ? {
            adminUser: {
              create: {
                name: payload.name ?? payload.email.split("@")[0],
                adminRole,
                status: adminRole === "SUPER_ADMIN" ? "ACTIVE" : "PENDING",
              },
            },
          }
        : {}),
    },
  });

  return { account, isNew: true };
}

export async function recordConsent(accountId: string, version: string) {
  return prisma.account.update({
    where: { id: accountId },
    data: {
      consentVersion: version,
      consentAcceptedAt: new Date(),
    },
  });
}

export async function softDeleteAccount(accountId: string) {
  const account = await prisma.account.findUniqueOrThrow({
    where: { id: accountId },
    include: { student: true, tutor: true },
  });
  if (account.status === "DELETED") return account;
  if (account.status === "BLOCKED") {
    throw Object.assign(new Error("Account is blocked"), { statusCode: 403 });
  }
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    // Tombstones keep the unique phone/WhatsApp columns free for the real numbers.
    if (account.student) {
      await tx.student.update({
        where: { id: account.student.id },
        data: {
          phoneNumber: tombstone(accountId, account.student.phoneNumber),
          whatsappNumber: tombstone(accountId, account.student.whatsappNumber),
        },
      });
      await tx.tuitionRequirement.updateMany({
        where: { studentId: account.student.id, status: "OPEN" },
        data: { status: "CLOSED" },
      });
      await tx.application.updateMany({
        where: { studentId: account.student.id, status: "PENDING" },
        data: { status: "WITHDRAWN" },
      });
    }
    if (account.tutor) {
      await tx.tutor.update({
        where: { id: account.tutor.id },
        data: {
          phoneNumber: tombstone(accountId, account.tutor.phoneNumber),
          whatsappNumber: tombstone(accountId, account.tutor.whatsappNumber),
        },
      });
      await tx.tuitionPackage.updateMany({
        where: { tutorId: account.tutor.id, status: "OPEN" },
        data: { status: "CLOSED" },
      });
      await tx.application.updateMany({
        where: { tutorId: account.tutor.id, status: "PENDING" },
        data: { status: "WITHDRAWN" },
      });
    }
    await tx.session.updateMany({
      where: { accountId, revokedAt: null },
      data: { revokedAt: now },
    });
    return tx.account.update({
      where: { id: accountId },
      data: { deletedAt: now, status: "DELETED" },
    });
  });
}

export async function hardDeleteAccount(accountId: string) {
  await prisma.$transaction(async (tx) => {
    // Sequential: a transaction client cannot run queries concurrently (pg deprecation warning).
    const student = await tx.student.findUnique({ where: { accountId }, select: { id: true } });
    const tutor = await tx.tutor.findUnique({ where: { accountId }, select: { id: true } });
    const admin = await tx.adminUser.findUnique({
      where: { accountId },
      select: { accountId: true },
    });

    const studentId = student?.id;
    const tutorId = tutor?.id;

    // Sessions and direct account-owned notifications.
    await tx.session.deleteMany({ where: { accountId } });
    await tx.notificationLog.deleteMany({ where: { recipientId: accountId } });

    // Account blocks, reports and disputes where this account is involved.
    await tx.accountBlock.deleteMany({
      where: {
        OR: [{ accountId }, { blockedById: accountId }, { unblockedById: accountId }],
      },
    });
    await tx.report.deleteMany({
      where: {
        OR: [{ reporterId: accountId }, { targetAccountId: accountId }, { handledById: accountId }],
      },
    });
    await tx.dispute.deleteMany({
      where: {
        OR: [{ raisedById: accountId }, { againstId: accountId }, { handledById: accountId }],
      },
    });

    if (admin) {
      // Clear admin references that would otherwise block admin_user deletion.
      await tx.tutorVerification.updateMany({
        where: { reviewedById: accountId },
        data: { reviewedById: null },
      });
      await tx.report.updateMany({
        where: { handledById: accountId },
        data: { handledById: null },
      });
      await tx.dispute.updateMany({
        where: { handledById: accountId },
        data: { handledById: null },
      });
      await tx.siteContent.updateMany({
        where: { updatedById: accountId },
        data: { updatedById: null },
      });
      await tx.platformSetting.updateMany({
        where: { updatedById: accountId },
        data: { updatedById: null },
      });
      await tx.blogPost.deleteMany({ where: { authorId: accountId } });
    }

    const applicationWhere: Prisma.ApplicationWhereInput = {};
    if (tutorId) applicationWhere.tutorId = tutorId;
    if (studentId) applicationWhere.studentId = studentId;

    const hasProfile = Boolean(tutorId || studentId);
    const appIds = hasProfile
      ? (await tx.application.findMany({ where: applicationWhere, select: { id: true } })).map(
          (a) => a.id,
        )
      : [];

    if (appIds.length > 0) {
      await tx.dispute.deleteMany({ where: { applicationId: { in: appIds } } });
      await tx.report.deleteMany({ where: { applicationId: { in: appIds } } });
      await tx.notificationLog.deleteMany({ where: { applicationId: { in: appIds } } });
    }

    // Platform fees and payments are append-only; if any exist the delete will
    // surface a foreign-key error and the caller can handle it.
    if (tutorId || appIds.length > 0) {
      const platformFeeWhere: Prisma.PlatformFeeWhereInput = {};
      if (tutorId) platformFeeWhere.tutorId = tutorId;
      if (appIds.length > 0) platformFeeWhere.applicationId = { in: appIds };
      await tx.platformFee.deleteMany({ where: platformFeeWhere });
    }

    const reviewWhere: Prisma.ReviewWhereInput = {};
    if (tutorId) reviewWhere.tutorId = tutorId;
    if (studentId) reviewWhere.studentId = studentId;

    if (hasProfile) {
      await tx.review.deleteMany({ where: reviewWhere });
      await tx.application.deleteMany({ where: applicationWhere });
    }

    if (studentId) {
      await tx.tuitionRequirement.deleteMany({ where: { studentId } });
      await tx.student.updateMany({
        where: { id: studentId },
        data: { verificationFileId: null, verificationStatus: "NOT_SUBMITTED" },
      });
      await tx.student.deleteMany({ where: { accountId } });
    }

    if (tutorId) {
      await tx.tuitionPackage.deleteMany({ where: { tutorId } });
      await tx.tutorVideo.deleteMany({ where: { tutorId } });
      await tx.tutorCredential.deleteMany({ where: { tutorId } });
      await tx.tutorVerification.deleteMany({ where: { tutorId } });
      await tx.tutorArea.deleteMany({ where: { tutorId } });
      await tx.tutorSubject.deleteMany({ where: { tutorId } });
      await tx.tutor.deleteMany({ where: { accountId } });
    }

    if (admin) {
      await tx.adminUser.deleteMany({ where: { accountId } });
    }

    // File assets must go after every row that references them.
    await tx.fileAsset.deleteMany({ where: { ownerAccountId: accountId } });

    await tx.account.delete({ where: { id: accountId } });
  });
}

export async function getMe(accountId: string) {
  const me = await prisma.account.findUnique({
    where: { id: accountId },
    include: { student: true, tutor: true, adminUser: true },
  });
  if (!me) return me;
  const student = me.student && {
    ...me.student,
    location: await findOwnLocation("student_location", me.student.id),
  };
  const tutor = me.tutor && {
    ...me.tutor,
    location: await findOwnLocation("tutor_location", me.tutor.id),
  };
  if (!tutor) return { ...me, student, tutor };

  const [readiness] = await prisma.$queryRaw<
    { missing: string[]; verificationRequired: boolean }[]
  >`
    SELECT tutor_missing_requirements(${tutor.id}::uuid) AS missing,
           COALESCE((SELECT (value #>> '{}')::boolean FROM platform_setting
                     WHERE key = 'require_tutor_verification'), false) AS "verificationRequired"`;
  return {
    ...me,
    student,
    tutor,
    applyReadiness: {
      ready: readiness.missing.length === 0,
      missing: readiness.missing,
      verificationRequired: readiness.verificationRequired,
    },
  };
}
