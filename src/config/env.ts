import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z.string(),
  TEST_DATABASE_URL: z.string().optional(),

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
});

export const env = schema.parse(process.env);
