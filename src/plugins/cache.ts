import type { FastifyReply, FastifyRequest } from "fastify";

// Public reads return the same body to everyone; signed-in callers must never be cached.
export function publicCache(request: FastifyRequest, reply: FastifyReply, cacheControl: string) {
  reply.header("Vary", "Authorization");
  reply.header("Cache-Control", request.account ? "private, no-store" : cacheControl);
}

// For a body that depends on who is asking (an unlisted tutor's profile, for one): no shared cache may keep it,
// whoever the caller is.
export function privateCache(reply: FastifyReply) {
  reply.header("Vary", "Authorization");
  reply.header("Cache-Control", "private, no-store");
}
