import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  ACADEMIC_GROUPS,
  ADMISSION_TARGETS,
  CURRICULA,
  educationLookup,
} from "../../lib/education.js";
import { routeDocs } from "../../openapi/docs.js";
import { sharedCache } from "../../plugins/cache.js";

// The lookup never changes at runtime, so build the body once.
const body = educationLookup();
const CACHE_SECONDS = 300;

const educationLookupSchema = z
  .object({
    version: z.number(),
    levelRange: z.object({ min: z.number(), max: z.number() }),
    groupLevels: z.object({ min: z.number(), max: z.number() }),
    admissionLevel: z.number(),
    levelNoteMaxLength: z.number(),
    curricula: z.array(
      z.object({
        code: z.enum(CURRICULA),
        label: z.string(),
        levels: z.array(z.object({ code: z.number(), label: z.string() })),
        groups: z.array(z.object({ code: z.enum(ACADEMIC_GROUPS), label: z.string() })),
      }),
    ),
    admissionTargets: z.array(
      z.object({
        code: z.enum(ADMISSION_TARGETS),
        label: z.string(),
        covers: z.string(),
      }),
    ),
    retakerLabels: z.array(
      z.object({
        level: z.number(),
        label: z.string(),
      }),
    ),
  })
  .meta({ id: "EducationLookup" });

export async function lookupRoutes(app: FastifyInstance) {
  app.get(
    "/education",
    {
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
      schema: {
        ...routeDocs({
          tag: "Lookups",
          summary: "Get education lookups",
          description:
            "Curricula with their levels and groups, admission targets, retaker labels and the level range. The same body for every caller. Cached for 5 minutes by shared caches; signed-in callers cache it in the browser only.",
          auth: "optional",
          signedInCache: `private, max-age=${CACHE_SECONDS}`,
          rateLimit: "120/min per IP",
        }),
        response: { 200: educationLookupSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      sharedCache(request, reply, CACHE_SECONDS);
      return body;
    },
  );
}
