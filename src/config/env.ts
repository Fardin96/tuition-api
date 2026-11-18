import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z.string(),
  DATABASE_POOL_URL: z.string().optional(),
  DATABASE_CA_CERT: z.string().optional(),
  TEST_DATABASE_URL: z.string().optional(),

  FRONTEND_URL: z.string().optional(),

  // Serves Swagger UI at /docs. On by default outside production; set "true" to force it on.
  API_DOCS: z.enum(["true", "false"]).optional(),

  GOOGLE_CLIENT_ID: z.string().optional(),

  ACCESS_TOKEN_SECRET: z.string().min(32).default("dev-secret-must-change-in-production-123"),
  ACCESS_TOKEN_TTL: z.string().default("15m"),
  REFRESH_TOKEN_SECRET: z
    .string()
    .min(32)
    .default("dev-refresh-secret-must-change-in-production-456"),
  REFRESH_TOKEN_TTL: z.string().default("30d"),

  R2_ENDPOINT: z.string().optional(),
  R2_REGION: z.string().optional(),
  R2_BUCKET: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_PUBLIC_URL_PREFIX: z.string().optional(),

  N8N_WEBHOOK_URL: z.string().optional(),
  N8N_WEBHOOK_SECRET: z.string().optional(),

  SUPER_ADMIN_EMAIL_1: z.string().email(),
  SUPER_ADMIN_EMAIL_2: z.string().email(),

  // SSLCommerz gateway. Sandbox unless SSLC_IS_LIVE is "true", which only production may use.
  SSLC_STORE_ID: z.string().optional(),
  SSLC_STORE_PASSWORD: z.string().optional(),
  SSLC_IS_LIVE: z.enum(["true", "false"]).default("false"),
  // Informational only: the SDK derives the gateway host from SSLC_IS_LIVE.
  SSLC_BASE_URL: z.string().optional(),
  // Public base of this API, used for gateway callback URLs (e.g. http://localhost:4000).
  API_PUBLIC_URL: z.string().url().optional(),
  // Public base of the web app the browser returns to (e.g. http://localhost:3000).
  WEB_PUBLIC_URL: z.string().url().optional(),
});

export const env = schema
  .superRefine((value, ctx) => {
    if (value.SSLC_IS_LIVE === "true" && value.NODE_ENV !== "production") {
      ctx.addIssue({
        code: "custom",
        path: ["SSLC_IS_LIVE"],
        message: "SSLC_IS_LIVE=true is only allowed when NODE_ENV=production",
      });
    }
  })
  .parse(process.env);
