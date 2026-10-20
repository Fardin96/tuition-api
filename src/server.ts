import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { env } from "./config/env.js";
import { authRoutes, meRoutes } from "./modules/auth/auth.routes.js";
import { verifyAccessToken } from "./modules/auth/auth.service.js";
import { healthRoutes } from "./plugins/health.js";

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: env.NODE_ENV === "development" ? "debug" : "info",
    },
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(helmet);
  await app.register(cors, {
    origin: env.NODE_ENV === "development",
    credentials: true,
  });
  await app.register(cookie);
  await app.register(rateLimit, {
    max: 100,
    timeWindow: "1 minute",
  });

  app.addHook("onRequest", async (request) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return;
    }
    const token = authHeader.slice(7);
    try {
      request.account = await verifyAccessToken(token);
    } catch {
      // Leave request.account undefined; routes enforce auth explicitly.
    }
  });

  await app.register(healthRoutes, { prefix: "/api/v1/health" });
  await app.register(authRoutes, { prefix: "/api/v1/auth" });
  await app.register(meRoutes, { prefix: "/api/v1/me" });

  app.setErrorHandler((error, _request, reply) => {
    const err = error as Error & { statusCode?: number };
    app.log.error(err);
    return reply.status(err.statusCode ?? 500).send({
      error: err.name,
      message: env.NODE_ENV === "production" ? "Internal server error" : err.message,
    });
  });

  return app;
}

async function main() {
  const app = await buildApp();
  try {
    await app.listen({ port: env.PORT, host: env.HOST });
    app.log.info(`Server listening on http://${env.HOST}:${env.PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
