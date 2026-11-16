// Writes openapi.json at the repo root: `yarn openapi:export`. `--check` fails when the file is stale.
// The app is built but never listens, and no query runs, so placeholder env values are enough.
import { readFileSync, writeFileSync } from "node:fs";

process.env.DATABASE_URL ??= "postgresql://openapi:openapi@localhost:5432/openapi?sslmode=disable";
process.env.SUPER_ADMIN_EMAIL_1 ||= "openapi-1@example.com";
process.env.SUPER_ADMIN_EMAIL_2 ||= "openapi-2@example.com";

const { buildApp } = await import("../server.js");
const { pool } = await import("../lib/prisma.js");

const app = await buildApp();
await app.ready();
const json = `${JSON.stringify(app.swagger(), null, 2)}\n`;
await app.close();
await pool.end();

const file = new URL("../../openapi.json", import.meta.url);

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(file, "utf8");
  } catch {}
  if (current !== json) {
    console.error("openapi.json is out of date. Run `yarn openapi:export` and commit it.");
    process.exit(1);
  }
  console.log("openapi.json is up to date.");
} else {
  writeFileSync(file, json);
  console.log("Wrote openapi.json");
}
