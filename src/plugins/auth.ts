import type { FastifyRequest } from "fastify";
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
