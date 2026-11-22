import "dotenv/config";
import pg from "pg";

if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.DATABASE_POOL_URL = process.env.TEST_DATABASE_URL;
}

// Tests never reach a real bucket: storage is off unless a test installs createFakeStorage().
for (const key of Object.keys(process.env)) {
  if (key.startsWith("R2_")) delete process.env[key];
}

import { afterAll, beforeAll, beforeEach } from "vitest";
import type { PrismaClient } from "../generated/prisma/client.js";

// Migrations run once per vitest run in global-setup.ts.

// Every file truncates the shared test database before each test, so two vitest runs at once (a
// pre-push hook and a manual run) wiped each other's rows: deadlocks, 401s, foreign key errors.
// Each file holds this session lock while it runs, so concurrent runs take turns file by file.
const TEST_DB_LOCK = 4_181_957_207;
const LOCK_WAIT_MS = 10 * 60_000;
const lock = new pg.Client({ connectionString: process.env.DATABASE_URL });

let prisma: PrismaClient;

beforeAll(async () => {
  await lock.connect();
  await lock.query("SELECT pg_advisory_lock($1)", [TEST_DB_LOCK]);
  const { prisma: client } = await import("../lib/prisma.js");
  prisma = client;
}, LOCK_WAIT_MS);

afterAll(async () => {
  // Closing the session releases the lock even if the unlock fails.
  await lock.query("SELECT pg_advisory_unlock($1)", [TEST_DB_LOCK]).catch(() => undefined);
  await lock.end();
});

beforeEach(async () => {
  const { setStorageForTests } = await import("../lib/storage.js");
  setStorageForTests(null);
  // matching_config lives in platform_setting (truncated below); drop the per-process copy too.
  const { resetMatchingConfigCache } = await import("../modules/matching/matching-config.js");
  resetMatchingConfigCache();

  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      session,
      admin_user,
      account_block,
      phone_otp,
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
      requirement_invite,
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
      site_content_file,
      site_content,
      story,
      audit_log,
      account,
      super_admin_email
    RESTART IDENTITY CASCADE;
  `);
  await prisma.$executeRawUnsafe(`
    INSERT INTO platform_setting (key, value, updated_at) VALUES
      ('require_tutor_verification', 'false'::jsonb, now()),
      ('require_tutor_phone_verification', 'false'::jsonb, now()),
      ('require_student_phone_verification', 'false'::jsonb, now())
    ON CONFLICT (key) DO NOTHING;
  `);
  // city is seeded by migration (Dhaka) and never truncated: drop cities a test added, keep Dhaka on.
  await prisma.$executeRawUnsafe(`DELETE FROM city WHERE slug <> 'dhaka'`);
  await prisma.$executeRawUnsafe(
    `UPDATE city SET is_active = true WHERE slug = 'dhaka' AND NOT is_active`,
  );
});
