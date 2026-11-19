import "./lib/bigint.js";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import etag from "@fastify/etag";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import {
  hasZodFastifySchemaValidationErrors,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { env } from "./config/env.js";
import { type AppError, ERROR_CODES, errorCodeOf } from "./lib/errors.js";
import { pool, startPoolStats } from "./lib/prisma.js";
import { adminAccountRoutes } from "./modules/admin/accounts.routes.js";
import { adminTeamRoutes } from "./modules/admin/admins.routes.js";
import { adminApplicationRoutes } from "./modules/admin/applications.routes.js";
import { adminAreaRoutes } from "./modules/admin/areas.routes.js";
import { adminAuditLogRoutes } from "./modules/admin/audit-logs.routes.js";
import { adminBlogRoutes } from "./modules/admin/blog.routes.js";
import { adminFeeRoutes } from "./modules/admin/fees.routes.js";
import { adminFileRoutes } from "./modules/admin/files.routes.js";
import { adminPackageRoutes } from "./modules/admin/packages.routes.js";
import { adminPaymentRoutes } from "./modules/admin/payments.routes.js";
import { adminPromoCodeRoutes } from "./modules/admin/promo-codes.routes.js";
import { adminRefundRoutes } from "./modules/admin/refunds.routes.js";
import { adminSettingRoutes } from "./modules/admin/settings.routes.js";
import { adminSubjectRoutes } from "./modules/admin/subjects.routes.js";
import { adminUploadRoutes } from "./modules/admin/uploads.routes.js";
import { adminVerificationRoutes } from "./modules/admin/verifications.routes.js";
import { adminVideoRoutes } from "./modules/admin/videos.routes.js";
import { adminZoneRequestRoutes } from "./modules/admin/zone-requests.routes.js";
import { applicationRoutes } from "./modules/application/application.routes.js";
import { authRoutes, meRoutes } from "./modules/auth/auth.routes.js";
import { verifyAccessToken } from "./modules/auth/auth.service.js";
import { blogRoutes } from "./modules/blog/blog.routes.js";
import { feeRoutes } from "./modules/fees/fee.routes.js";
import { fileRoutes } from "./modules/files/files.routes.js";
import { areaRoutes } from "./modules/lookups/areas.routes.js";
import { lookupRoutes } from "./modules/lookups/lookups.routes.js";
import { subjectRoutes } from "./modules/lookups/subjects.routes.js";
import { notificationRoutes } from "./modules/notification/notification.routes.js";
import { packageRoutes } from "./modules/package/package.routes.js";
import { paymentRoutes } from "./modules/payment/payment.routes.js";
import { sslcommerzCallbackRoutes } from "./modules/payment/sslcommerz.callbacks.js";
import { requirementRoutes } from "./modules/requirement/requirement.route.js";
import { studentRoutes } from "./modules/student/student.routes.js";
import { publicVideoRoutes, tutorRoutes } from "./modules/tutor/tutor.routes.js";
import { zoneRoutes } from "./modules/zone/zone.routes.js";
import { registerOpenApi } from "./openapi/plugin.js";
import { healthRoutes } from "./plugins/health.js";

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: env.NODE_ENV === "development" ? "debug" : "info",
    },
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.setErrorHandler((error, _request, reply) => {
    // @fastify/rate-limit throws a plain object, so do not assume an Error instance.
    const err = error as Partial<AppError> & { message?: string };
    const status = err.statusCode ?? 500;
    app.log.error(err);
    const masked = env.NODE_ENV === "production" && status >= 500;
    const body: Record<string, unknown> = {
      error: status === 429 ? "RateLimited" : (err.name ?? "Error"),
      code: errorCodeOf(err),
      message: masked ? "Internal server error" : (err.message ?? ""),
    };
    if (err.details && !masked) body.details = err.details;
    if (err.issues && !masked) body.issues = err.issues;
    if (hasZodFastifySchemaValidationErrors(error)) {
      body.error = "ValidationError";
      body.code = ERROR_CODES.ValidationError;
      body.issues = error.validation.map((issue) => ({
        path: issue.instancePath
          .split("/")
          .filter(Boolean)
          .map((part) => (/^\d+$/.test(part) ? Number(part) : part)),
        message: issue.message,
      }));
    }
    return reply.status(status).send(body);
  });

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
  await app.register(etag);
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

  await registerOpenApi(app);

  await app.register(healthRoutes, { prefix: "/api/v1/health" });
  await app.register(authRoutes, { prefix: "/api/v1/auth" });
  await app.register(meRoutes, { prefix: "/api/v1/me" });
  await app.register(studentRoutes, { prefix: "/api/v1/students" });
  await app.register(tutorRoutes, { prefix: "/api/v1/tutors" });
  await app.register(zoneRoutes, { prefix: "/api/v1/tutors/me" });
  await app.register(requirementRoutes, { prefix: "/api/v1/requirements" });
  await app.register(packageRoutes, { prefix: "/api/v1/packages" });
  // Full paths: /requirements/:id/applications, /packages/:id/applications and /applications/*.
  await app.register(applicationRoutes, { prefix: "/api/v1" });
  await app.register(notificationRoutes, { prefix: "/api/v1/notifications" });
  // Full paths: /fees/mine, /fees/:id, /fees/:id/checkout and /fees/:id/attempts/:tranId.
  await app.register(feeRoutes, { prefix: "/api/v1/fees" });
  await app.register(paymentRoutes, { prefix: "/api/v1/fees" });
  // Browser redirects and server-to-server IPN from SSLCommerz; hidden from OpenAPI.
  await app.register(sslcommerzCallbackRoutes, { prefix: "/api/v1/payments/sslcommerz" });
  await app.register(publicVideoRoutes, { prefix: "/api/v1/videos" });
  await app.register(fileRoutes, { prefix: "/api/v1/files" });
  await app.register(blogRoutes, { prefix: "/api/v1/blog" });
  await app.register(lookupRoutes, { prefix: "/api/v1/lookups" });
  await app.register(areaRoutes, { prefix: "/api/v1/areas" });
  await app.register(subjectRoutes, { prefix: "/api/v1/subjects" });
  await app.register(adminZoneRequestRoutes, { prefix: "/api/v1/admin/zone-limit-requests" });
  await app.register(adminTeamRoutes, { prefix: "/api/v1/admin/admins" });
  await app.register(adminAccountRoutes, { prefix: "/api/v1/admin/accounts" });
  await app.register(adminUploadRoutes, { prefix: "/api/v1/admin/accounts" });
  await app.register(adminApplicationRoutes, { prefix: "/api/v1/admin/applications" });
  // Full paths: /admin/fees/* and /admin/payments/:id/reverse.
  await app.register(adminFeeRoutes, { prefix: "/api/v1/admin" });
  await app.register(adminPaymentRoutes, { prefix: "/api/v1/admin" });
  await app.register(adminPromoCodeRoutes, { prefix: "/api/v1/admin" });
  await app.register(adminRefundRoutes, { prefix: "/api/v1/admin" });
  await app.register(adminPackageRoutes, { prefix: "/api/v1/admin/packages" });
  await app.register(adminSubjectRoutes, { prefix: "/api/v1/admin/subjects" });
  await app.register(adminAreaRoutes, { prefix: "/api/v1/admin/areas" });
  await app.register(adminSettingRoutes, { prefix: "/api/v1/admin/settings" });
  await app.register(adminAuditLogRoutes, { prefix: "/api/v1/admin/audit-logs" });
  await app.register(adminVerificationRoutes, { prefix: "/api/v1/admin/verifications" });
  await app.register(adminVideoRoutes, { prefix: "/api/v1/admin/videos" });
  await app.register(adminFileRoutes, { prefix: "/api/v1/admin/files" });
  await app.register(adminBlogRoutes, { prefix: "/api/v1/admin/blog" });

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
  startPoolStats(app.log);

  // DO App Platform sends SIGTERM on every deploy; release connections before the new instance starts.
  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received, draining`);
    setTimeout(() => process.exit(1), 10_000).unref();
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
