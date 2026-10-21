import { readFileSync } from "node:fs";
import { PrismaPg } from "@prisma/adapter-pg";
import { env } from "../config/env.js";
import { PrismaClient } from "../generated/prisma/client.js";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function getCaCert(): string | undefined {
  if (env.DATABASE_CA_CERT) return env.DATABASE_CA_CERT;
  try {
    // Dev fallback: download the CA cert from the DO dashboard and place it at repo root.
    return readFileSync("ca-certificate.crt", "utf-8");
  } catch {
    return undefined;
  }
}

function buildPgConfig() {
  // Runtime app connections go through the pooler when available.
  // Migrations / Prisma CLI commands use DATABASE_URL directly.
  const connectionUrl = env.DATABASE_POOL_URL ?? env.DATABASE_URL;
  const url = new URL(connectionUrl);
  const isPooler = url.port === "25061" || url.pathname.includes("-pool");

  // sslmode=require is a libpq/psql convention; node-postgres expects explicit SSL options.
  url.searchParams.delete("sslmode");

  const connectionString = url.toString();
  const ca = getCaCert();

  return {
    connectionString,
    ssl: {
      rejectUnauthorized: Boolean(ca),
      ca,
    },
    // Transaction poolers cannot handle prepared statements across checkout/checkin.
    // Setting prepareThreshold: 0 disables prepared statements for the pooler URL.
    ...(isPooler ? { prepareThreshold: 0 } : {}),
  };
}

const adapter = new PrismaPg(buildPgConfig());

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
    log: env.NODE_ENV === "development" ? ["query", "error", "warn"] : ["error"],
  });

if (env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
