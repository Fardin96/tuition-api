import "dotenv/config";
import { execSync } from "node:child_process";

if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.DATABASE_POOL_URL = process.env.TEST_DATABASE_URL;
}

import { beforeAll, beforeEach } from "vitest";
import type { PrismaClient } from "../generated/prisma/client.js";

let prisma: PrismaClient;

beforeAll(async () => {
  const { prisma: client } = await import("../lib/prisma.js");
  prisma = client;

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
      account_block,
      report,
      dispute,
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
