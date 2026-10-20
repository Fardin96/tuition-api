import type { FastifyInstance } from "fastify";
import { prisma } from "../lib/prisma.js";

export async function healthRoutes(app: FastifyInstance) {
  app.get("/", async (_request, reply) => {
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
  });
}
