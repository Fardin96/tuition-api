import type { FastifyInstance } from "fastify";
import { prisma } from "../lib/prisma.js";

export async function healthRoutes(app: FastifyInstance) {
  app.get("/", async (_request, reply) => {
    const dbCheck = await prisma.$queryRaw`SELECT 1 as ok`;
    return reply.send({
      status: "ok",
      db: dbCheck,
      timestamp: new Date().toISOString(),
    });
  });
}
