SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Checks existing alerts against the shape added NOT VALID in 20261126000100_upload_moderation.
-- Every existing row is an application alert with an application_id.
ALTER TABLE "app_notification" VALIDATE CONSTRAINT "app_notification_application_shape";
