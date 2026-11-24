SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Daily limits on applications, package requests and accepts (rolling 24 hours, per account).
-- No rows are written: the API uses its defaults (50, 20, 20) until a super admin saves a value.
-- squawk-ignore ban-drop-constraint
ALTER TABLE "platform_setting" DROP CONSTRAINT "platform_setting_value_valid";
ALTER TABLE "platform_setting" ADD CONSTRAINT "platform_setting_value_valid" CHECK (
  CASE key
    WHEN 'require_tutor_verification' THEN jsonb_typeof(value) = 'boolean'
    WHEN 'require_tutor_phone_verification' THEN jsonb_typeof(value) = 'boolean'
    WHEN 'require_student_phone_verification' THEN jsonb_typeof(value) = 'boolean'
    WHEN 'online_payments_enabled' THEN jsonb_typeof(value) = 'boolean'
    WHEN 'commission_percent' THEN
      CASE WHEN jsonb_typeof(value) = 'number' THEN (value #>> '{}')::numeric BETWEEN 0 AND 100 ELSE false END
    WHEN 'gateway_charge_percent' THEN
      CASE WHEN jsonb_typeof(value) = 'number' THEN (value #>> '{}')::numeric BETWEEN 0 AND 10 ELSE false END
    WHEN 'refund_window_days' THEN
      CASE WHEN jsonb_typeof(value) = 'number'
        THEN (value #>> '{}')::numeric BETWEEN 0 AND 90 AND (value #>> '{}')::numeric = trunc((value #>> '{}')::numeric)
        ELSE false END
    WHEN 'daily_application_limit' THEN
      CASE WHEN jsonb_typeof(value) = 'number'
        THEN (value #>> '{}')::numeric BETWEEN 1 AND 1000 AND (value #>> '{}')::numeric = trunc((value #>> '{}')::numeric)
        ELSE false END
    WHEN 'daily_package_request_limit' THEN
      CASE WHEN jsonb_typeof(value) = 'number'
        THEN (value #>> '{}')::numeric BETWEEN 1 AND 1000 AND (value #>> '{}')::numeric = trunc((value #>> '{}')::numeric)
        ELSE false END
    WHEN 'daily_accept_limit' THEN
      CASE WHEN jsonb_typeof(value) = 'number'
        THEN (value #>> '{}')::numeric BETWEEN 1 AND 1000 AND (value #>> '{}')::numeric = trunc((value #>> '{}')::numeric)
        ELSE false END
    WHEN 'matching_config' THEN jsonb_typeof(value) = 'object'
    ELSE false
  END) NOT VALID;

-- One row per send or accept, kept for 24 hours and pruned by the limit check. The table is new and
-- empty, so the index is built in the same transaction. No FK: party_id is a tutor or student id.
CREATE TABLE "daily_action" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "party_id" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT "daily_action_kind_valid" CHECK ("kind" IN ('application', 'package_request', 'accept'))
);

-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "daily_action_party_kind_at_idx" ON "daily_action"("party_id", "kind", "at");
