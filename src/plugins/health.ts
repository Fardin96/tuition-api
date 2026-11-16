import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { routeDocs } from "../openapi/docs.js";

// 200 when the database answers; 503 with the same body shape when it does not.
const healthSchema = z
  .object({
    status: z.enum(["ok", "degraded"]),
    db: z.enum(["ok", "unavailable"]),
    timestamp: z.string(),
  })
  .meta({ id: "Health" });

export async function healthRoutes(app: FastifyInstance) {
  app.get(
    "/",
    {
      schema: {
        ...routeDocs({
          tag: "Health",
          summary: "Liveness and database check",
          description: "Returns 503 with status degraded when the database does not answer.",
          auth: "public",
          errors: [],
        }),
        response: { 200: healthSchema, 503: healthSchema },
      },
    },
    async (_request, reply) => {
      reply.header("Cache-Control", "no-store");
      let db = "ok";
      try {
        await prisma.$queryRaw`SELECT 1 as ok`;
      } catch (err) {
        app.log.error({ err }, "health db check failed");
        db = "unavailable";
        return reply.status(503).send({
          status: "degraded",
          db,
          timestamp: new Date().toISOString(),
        });
      }
      return reply.send({
        status: "ok",
        db,
        timestamp: new Date().toISOString(),
      });
    },
  );
}
