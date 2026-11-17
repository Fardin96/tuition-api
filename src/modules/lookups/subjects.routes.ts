import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { routeDocs } from "../../openapi/docs.js";
import { publicCache } from "../../plugins/cache.js";

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
            "Active subjects only, ordered by sortOrder then name. Cached for 5 minutes; signed-in callers get no-store.",
          auth: "optional",
          rateLimit: "120/min per IP",
        }),
        response: { 200: subjectListSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      publicCache(request, reply, "public, max-age=300, stale-while-revalidate=600");
      const subjects = await prisma.subject.findMany({
        where: { isActive: true },
        select: { id: true, name: true, slug: true },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      });
      return { subjects };
    },
  );
}
