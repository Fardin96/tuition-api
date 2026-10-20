import "dotenv/config";
import { execSync } from "node:child_process";

if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}

import { beforeAll, beforeEach } from "vitest";
import { prisma } from "../lib/prisma.js";

beforeAll(async () => {
  execSync("npx prisma migrate deploy", {
    stdio: "ignore",
    env: { ...process.env },
  });
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      session,
      admin_user,
      student,
      tutor,
      account,
      super_admin_email
    RESTART IDENTITY CASCADE;
  `);
});
