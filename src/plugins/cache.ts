import type { FastifyReply, FastifyRequest } from "fastify";

// Public reads return the same body to everyone; signed-in callers must never be cached.
export function publicCache(request: FastifyRequest, reply: FastifyReply, cacheControl: string) {
  reply.header("Vary", "Authorization");
  reply.header("Cache-Control", request.account ? "private, no-store" : cacheControl);
}
