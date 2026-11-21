SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Checks existing rows against the constraints added NOT VALID in 20261128000100_matching.
ALTER TABLE "app_notification" VALIDATE CONSTRAINT "app_notification_requirement_id_fkey";
ALTER TABLE "app_notification" VALIDATE CONSTRAINT "app_notification_requirement_shape";
ALTER TABLE "platform_setting" VALIDATE CONSTRAINT "platform_setting_value_valid";
