import type { FastifyRequest } from "fastify";

export const TOO_MANY_REQUESTS = "Too many requests. Try again in a minute.";

// Route config for a per-account limit. The rate-limit hook runs at route level, after the
// global auth hook, so request.account is already set here.
export function accountRateLimit(max: number, timeWindow: string, message = TOO_MANY_REQUESTS) {
  return {
    rateLimit: {
      max,
      timeWindow,
      keyGenerator: (request: FastifyRequest) => request.account?.accountId ?? request.ip,
      errorResponseBuilder: (_request: FastifyRequest, context: { statusCode: number }) => ({
        statusCode: context.statusCode,
        message,
      }),
    },
  };
}
