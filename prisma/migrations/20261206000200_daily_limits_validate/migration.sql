SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Validate the NOT VALID settings check from 20261206000100_daily_limits (SHARE UPDATE EXCLUSIVE).
ALTER TABLE "platform_setting" VALIDATE CONSTRAINT "platform_setting_value_valid";
