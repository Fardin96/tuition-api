import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { routeDocs } from "../../openapi/docs.js";
import { sharedCache } from "../../plugins/cache.js";
import {
  type InstitutionSearchQuery,
  institutionListSchema,
  institutionSearchQuerySchema,
} from "./institutions.schema.js";
import { searchInstitutions } from "./institutions.service.js";

const CACHE_SECONDS = 300;

export async function institutionRoutes(app: FastifyInstance) {
  app.get(
    "/",
    {
      config: { rateLimit: { max: 240, timeWindow: "1 minute" } },
      schema: {
        ...routeDocs({
          tag: "Lookups",
          summary: "Search schools and universities",
          description:
            "Active institutions whose name or alias matches q (2 to 60 characters, spelling variants folded). for=tutor ranks universities and colleges first; for=student ranks schools first. matchedAlias is set when q matches an alias. The same body for every caller. Cached for 5 minutes by shared caches; signed-in callers cache it in the browser only.",
          auth: "optional",
          signedInCache: `private, max-age=${CACHE_SECONDS}`,
          rateLimit: "240/min per IP",
        }),
        querystring: institutionSearchQuerySchema,
        response: { 200: institutionListSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      sharedCache(request, reply, CACHE_SECONDS);
      const { q, for: forRole, limit } = request.query as InstitutionSearchQuery;
      const institutions = await searchInstitutions(q, forRole, limit);
      return { institutions };
    },
  );
}
