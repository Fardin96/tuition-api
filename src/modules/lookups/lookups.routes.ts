import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { educationLookup } from "../../lib/education.js";
import { publicCache } from "../../plugins/cache.js";

// The lookup never changes at runtime, so build the body once.
const body = educationLookup();

export async function lookupRoutes(app: FastifyInstance) {
  app.get(
    "/education",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      publicCache(request, reply, "public, max-age=300, stale-while-revalidate=600");
      return body;
    },
  );
}
