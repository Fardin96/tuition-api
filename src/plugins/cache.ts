import type { FastifyReply, FastifyRequest } from "fastify";

// Public reads return the same body to everyone; signed-in callers must never be cached.
export function publicCache(request: FastifyRequest, reply: FastifyReply, cacheControl: string) {
  reply.header("Vary", "Authorization");
  reply.header("Cache-Control", request.account ? "private, no-store" : cacheControl);
}

// For a body that is byte-for-byte the same for every caller (subjects, areas, education lookups, the
// landing content). Anonymous callers may share it through a CDN or proxy. A signed-in caller keeps its
// copy in the browser only: the header says private, so no shared cache stores a response to a token.
export function sharedCache(request: FastifyRequest, reply: FastifyReply, maxAgeSeconds: number) {
  reply.header("Vary", "Authorization");
  reply.header(
    "Cache-Control",
    request.account
      ? `private, max-age=${maxAgeSeconds}`
      : `public, max-age=${maxAgeSeconds}, stale-while-revalidate=${maxAgeSeconds * 2}`,
  );
}

// For a body that depends on who is asking (an unlisted tutor's profile, for one): no shared cache may keep it,
// whoever the caller is.
export function privateCache(reply: FastifyReply) {
  reply.header("Vary", "Authorization");
  reply.header("Cache-Control", "private, no-store");
}
