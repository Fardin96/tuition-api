import type { FastifyRequest } from "fastify";
import { prisma } from "../lib/prisma.js";
import type { AuthContext } from "../modules/auth/auth.schema.js";

declare module "fastify" {
  interface FastifyRequest {
    account?: AuthContext;
  }
}

export function requireAuth(request: FastifyRequest): AuthContext {
  if (!request.account) {
    throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
  }
  return request.account;
}

export function requireRole(request: FastifyRequest, ...roles: AuthContext["role"][]) {
  const account = requireAuth(request);
  if (roles.length > 0 && !roles.includes(account.role)) {
    throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
  }
  return account;
}

// Admin routes need an ACTIVE admin_user row, not just the ADMIN role in the token:
// a PENDING or REMOVED admin keeps a valid token until it expires.
export async function requireAdmin(request: FastifyRequest) {
  const account = requireRole(request, "ADMIN");
  const admin = await prisma.adminUser.findUnique({
    where: { accountId: account.accountId },
    select: { status: true, adminRole: true },
  });
  if (admin?.status !== "ACTIVE") {
    throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
  }
  return { ...account, adminRole: admin.adminRole };
}

// Super-admin-only routes (admin approval, blocking, settings): an ACTIVE admin_user with admin_role SUPER_ADMIN.
export async function requireSuperAdmin(request: FastifyRequest) {
  const admin = await requireAdmin(request);
  if (admin.adminRole !== "SUPER_ADMIN") {
    throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
  }
  return admin;
}
