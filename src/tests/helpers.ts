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
