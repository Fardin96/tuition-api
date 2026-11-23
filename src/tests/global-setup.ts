import "dotenv/config";
import { execSync } from "node:child_process";
import pg from "pg";

/**
 * Runs once per vitest run, before any test file: brings the test database up to the latest
 * migration. It used to run in every file's beforeAll, where 79 `npx prisma` launches each had
 * the 10 s hook timeout to themselves and timed out whenever the machine was busy.
 */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
  const env = { ...process.env, DATABASE_URL: url, DATABASE_POOL_URL: url };
  const deploy = () =>
    execSync("npx prisma migrate deploy", { stdio: "pipe", encoding: "utf8", env });

  try {
    deploy();
  } catch (err) {
    const { stdout = "", stderr = "" } = err as { stdout?: string; stderr?: string };
    const output = `${stdout}${stderr}`;
    if (!output.includes("P3005") || !new URL(url).pathname.includes("test")) {
      throw new Error(`prisma migrate deploy failed:\n${output}`);
    }
    // The DB has tables but no migration history (P3005), so it is rebuilt from the migrations.
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await client.query("DROP SCHEMA public CASCADE");
      await client.query("CREATE SCHEMA public");
      await client.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
      await client.query("CREATE EXTENSION IF NOT EXISTS postgis");
    } finally {
      await client.end();
    }
    deploy();
  }
}
