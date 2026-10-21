import crypto from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { env } from "../../config/env.js";
import type { Role } from "../../generated/prisma/enums.js";
import type { AccountModel } from "../../generated/prisma/models/Account.js";
import { prisma } from "../../lib/prisma.js";

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
  if (!session || session.revokedAt || session.expiresAt < new Date()) {
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

export async function createOrUpdateAccount(
  payload: GoogleTokenPayload,
  role: Role | undefined,
  consentVersion?: string,
): Promise<{ account: AccountModel; isNew: boolean }> {
  const existing = await prisma.account.findUnique({
    where: { googleSub: payload.sub },
  });

  if (existing) {
    if (existing.status === "DELETED") {
      throw new Error("Account has been deleted");
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
  await prisma.session.updateMany({
    where: { accountId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return prisma.account.update({
    where: { id: accountId },
    data: { deletedAt: new Date(), status: "DELETED" },
  });
}

export async function getMe(accountId: string) {
  return prisma.account.findUnique({
    where: { id: accountId },
    include: {
      student: true,
      tutor: true,
      adminUser: true,
    },
  });
}
