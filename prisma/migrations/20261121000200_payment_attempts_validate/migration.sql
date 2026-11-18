SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Validate the NOT VALID checks from 20261121000100_payment_attempts (SHARE UPDATE EXCLUSIVE, writes keep flowing).
ALTER TABLE "fee_payment" VALIDATE CONSTRAINT "fee_payment_recorder_required";
ALTER TABLE "platform_setting" VALIDATE CONSTRAINT "platform_setting_value_valid";
