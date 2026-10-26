import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { env } from "./config/env.js";
import { authRoutes, meRoutes } from "./modules/auth/auth.routes.js";
import { verifyAccessToken } from "./modules/auth/auth.service.js";
import { requirementRoutes } from "./modules/requirement/requirement.route.js";
import { studentRoutes } from "./modules/student/student.routes.js";
import { publicVideoRoutes, tutorRoutes } from "./modules/tutor/tutor.routes.js";
import { healthRoutes } from "./plugins/health.js";

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: env.NODE_ENV === "development" ? "debug" : "info",
    },
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const productionOrigins = env.FRONTEND_URL
    ? env.FRONTEND_URL.split(",").map((url) => url.trim())
    : ["https://tution-media-mocha.vercel.app"];

  await app.register(helmet);
  await app.register(cors, {
    origin: env.NODE_ENV === "development" ? true : productionOrigins,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
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
  await app.register(studentRoutes, { prefix: "/api/v1/students" });
  await app.register(tutorRoutes, { prefix: "/api/v1/tutors" });
  await app.register(requirementRoutes, { prefix: "/api/v1/requirements" });
  await app.register(publicVideoRoutes, { prefix: "/api/v1/videos" });

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
