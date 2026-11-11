import { readFileSync } from "node:fs";
import { PrismaPg } from "@prisma/adapter-pg";
import type { FastifyBaseLogger } from "fastify";
import { Pool } from "pg";
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

  // node-postgres ignores Prisma-engine URL params; pool size must be passed as `max`.
  const max = Number(url.searchParams.get("connection_limit")) || 3;
  const sslMode = url.searchParams.get("sslmode");
  // PgBouncer rejects the startup `options` parameter; the DB-level timeouts cover pooled URLs.
  const pooled = url.searchParams.get("pgbouncer") === "true" || url.hostname.includes("pool");
  // sslmode=require is a libpq/psql convention; node-postgres expects explicit SSL options.
  for (const p of ["sslmode", "pgbouncer", "connection_limit"]) url.searchParams.delete(p);

  const ca = getCaCert();

  return {
    connectionString: url.toString(),
    max,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    ...(pooled
      ? {}
      : { options: "-c statement_timeout=10000 -c idle_in_transaction_session_timeout=15000" }),
    ...(sslMode !== "disable"
      ? {
          ssl: {
            rejectUnauthorized: Boolean(ca),
            ca,
          },
        }
      : {}),
  };
}

export const pool = new Pool(buildPgConfig());
pool.on("error", (err) => console.error("pg pool error", err));

export function startPoolStats(log: FastifyBaseLogger) {
  const timer = setInterval(() => {
    log.info(
      { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
      "db pool stats",
    );
  }, 60_000).unref();
  return () => clearInterval(timer);
}

const adapter = new PrismaPg(pool);

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
    log: env.NODE_ENV === "development" ? ["query", "error", "warn"] : ["error"],
  });

if (env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
