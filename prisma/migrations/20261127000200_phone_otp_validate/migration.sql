SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Validate the NOT VALID settings check from 20261127000100_phone_otp (SHARE UPDATE EXCLUSIVE, writes keep flowing).
ALTER TABLE "platform_setting" VALIDATE CONSTRAINT "platform_setting_value_valid";
