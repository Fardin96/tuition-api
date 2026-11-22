import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { routeDocs } from "../../openapi/docs.js";
import { sharedCache } from "../../plugins/cache.js";

const CACHE_SECONDS = 300;

const subjectSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    slug: z.string(),
  })
  .meta({ id: "Subject" });

const subjectListSchema = z
  .object({ subjects: z.array(subjectSchema) })
  .meta({ id: "SubjectList" });

export async function subjectRoutes(app: FastifyInstance) {
  app.get(
    "/",
    {
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
      schema: {
        ...routeDocs({
          tag: "Lookups",
          summary: "List subjects",
          description:
            "Active subjects only, ordered by sortOrder then name. The same body for every caller. Cached for 5 minutes by shared caches; signed-in callers cache it in the browser only.",
          auth: "optional",
          signedInCache: `private, max-age=${CACHE_SECONDS}`,
          rateLimit: "120/min per IP",
        }),
        response: { 200: subjectListSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      sharedCache(request, reply, CACHE_SECONDS);
      const subjects = await prisma.subject.findMany({
        where: { isActive: true },
        select: { id: true, name: true, slug: true },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      });
      return { subjects };
    },
  );
}
