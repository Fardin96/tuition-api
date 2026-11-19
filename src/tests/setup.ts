import "dotenv/config";
import { execSync } from "node:child_process";

if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.DATABASE_POOL_URL = process.env.TEST_DATABASE_URL;
}

// Tests never reach a real bucket: storage is off unless a test installs createFakeStorage().
for (const key of Object.keys(process.env)) {
  if (key.startsWith("R2_")) delete process.env[key];
}

import { beforeAll, beforeEach } from "vitest";
import type { PrismaClient } from "../generated/prisma/client.js";

let prisma: PrismaClient;

beforeAll(async () => {
  const { prisma: client } = await import("../lib/prisma.js");
  prisma = client;

  try {
    execSync("npx prisma migrate deploy", {
      stdio: "pipe",
      encoding: "utf8",
      env: { ...process.env },
    });
  } catch (err) {
    const { stdout = "", stderr = "" } = err as { stdout?: string; stderr?: string };
    const output = `${stdout}${stderr}`;
    const dbName = new URL(process.env.DATABASE_URL ?? "").pathname;
    if (!output.includes("P3005") || !dbName.includes("test")) {
      throw new Error(`prisma migrate deploy failed:\n${output}`);
    }
    // The DB has tables but no migration history (P3005), so it is rebuilt from the migrations.
    await prisma.$executeRawUnsafe("DROP SCHEMA public CASCADE");
    await prisma.$executeRawUnsafe("CREATE SCHEMA public");
    await prisma.$executeRawUnsafe("CREATE EXTENSION IF NOT EXISTS pg_trgm");
    await prisma.$executeRawUnsafe("CREATE EXTENSION IF NOT EXISTS postgis");
    execSync("npx prisma migrate deploy", {
      stdio: "pipe",
      encoding: "utf8",
      env: { ...process.env },
    });
  }
});

beforeEach(async () => {
  const { setStorageForTests } = await import("../lib/storage.js");
  setStorageForTests(null);

  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      session,
      admin_user,
      account_block,
      upload_review,
      upload_block,
      report,
      dispute,
      payment_refund,
      payment_attempt,
      promo_redemption,
      promo_code,
      fee_payment,
      platform_fee,
      notification_log,
      app_notification,
      application,
      review,
      tuition_requirement,
      tutor_video,
      tutor_credential,
      tutor_verification,
      tutor_subject,
      tutor_area,
      tutor_location,
      student_location,
      tutor_requirement,
      tutor_requirement_subject,
      tutor_zone,
      tutor_requirement_zone,
      zone_limit_request,
      platform_setting,
      tutor,
      student,
      file_asset,
      tuition_package,
      package_subject,
      package_zone,
      subject,
      area,
      blog_post,
      site_content,
      audit_log,
      account,
      super_admin_email
    RESTART IDENTITY CASCADE;
  `);
  await prisma.$executeRawUnsafe(`
    INSERT INTO platform_setting (key, value, updated_at) VALUES
      ('require_tutor_verification', 'false'::jsonb, now()),
      ('require_phone_verification', 'false'::jsonb, now())
    ON CONFLICT (key) DO NOTHING;
  `);
});
