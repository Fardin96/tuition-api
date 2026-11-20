SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Phone OTP verification. Expand step: the new table is written by the app from this release on.
-- The platform_setting CHECK is replaced NOT VALID here and validated in the next migration.

-- One row per code sent. Only an HMAC of the code is stored; the code itself never reaches the database.
CREATE TABLE "phone_otp" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "phone_number" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    -- Wrong-code count, 0..5 (CHECK below); SMALLINT matches the other small counters in the schema.
    -- squawk-ignore prefer-bigint-over-smallint
    "attempts" SMALLINT NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "verified_at" TIMESTAMPTZ(3),
    "consumed_at" TIMESTAMPTZ(3),
    "provider_request_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "phone_otp_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "phone_otp_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "phone_otp_phone_format" CHECK ("phone_number" ~ '^\+8801[3-9][0-9]{8}$'),
    CONSTRAINT "phone_otp_attempts_range" CHECK ("attempts" BETWEEN 0 AND 5)
);

-- New, empty table: CONCURRENTLY cannot run inside the migration transaction, and nothing is locked.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "phone_otp_account_id_phone_number_created_at_idx" ON "phone_otp"("account_id", "phone_number", "created_at");
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "phone_otp_phone_number_created_at_idx" ON "phone_otp"("phone_number", "created_at");

-- The single switch require_phone_verification becomes two switches, one per role. The new rows copy its value
-- (false when the row is missing). The CASE below has no branch for the old key, so the old CHECK must go
-- before the new keys are written.
-- squawk-ignore ban-drop-constraint
ALTER TABLE "platform_setting" DROP CONSTRAINT "platform_setting_value_valid";

INSERT INTO "platform_setting" ("key", "value", "updated_at")
SELECT k.key,
       COALESCE((SELECT p."value" FROM "platform_setting" p WHERE p."key" = 'require_phone_verification'), 'false'::jsonb),
       now()
FROM (VALUES ('require_tutor_phone_verification'), ('require_student_phone_verification')) AS k(key)
ON CONFLICT ("key") DO NOTHING;

DELETE FROM "platform_setting" WHERE "key" = 'require_phone_verification';

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
    ELSE false
  END
) NOT VALID;

-- tutor_missing_requirements, as in 20261107000300_v6_constraints, with the phone switch renamed.
CREATE OR REPLACE FUNCTION tutor_missing_requirements(p_tutor uuid) RETURNS text[]
LANGUAGE sql STABLE AS $$
  SELECT array_remove(ARRAY[
    CASE WHEN btrim(t.name) = ''    THEN 'name' END,
    CASE WHEN btrim(t.address) = '' THEN 'address' END,
    CASE WHEN NOT EXISTS (SELECT 1 FROM tutor_location l
                          WHERE l.tutor_id = t.id AND l.geog IS NOT NULL AND l.district_code <> '')
         THEN 'location_pin' END,
    CASE WHEN NOT EXISTS (SELECT 1 FROM tutor_area ta WHERE ta.tutor_id = t.id) THEN 'area' END,
    CASE WHEN t.phone_number IS NULL OR t.phone_number LIKE 'deleted:%' THEN 'phone_number' END,
    CASE WHEN COALESCE((SELECT (value #>> '{}')::boolean FROM platform_setting
                        WHERE key = 'require_tutor_phone_verification'), false)
              AND t.phone_verified_at IS NULL THEN 'phone_verification' END,
    CASE WHEN NOT EXISTS (
           SELECT 1 FROM tutor_requirement r
           WHERE r.tutor_id = t.id AND r.is_default AND r.is_active
             AND EXISTS (SELECT 1 FROM tutor_requirement_subject s WHERE s.requirement_id = r.id)
             AND (r.teaches_online
                  OR EXISTS (SELECT 1 FROM tutor_requirement_zone z WHERE z.requirement_id = r.id)))
         THEN 'default_requirement' END,
    CASE WHEN COALESCE((SELECT (value #>> '{}')::boolean FROM platform_setting
                        WHERE key = 'require_tutor_verification'), false)
              AND t.verification_status <> 'APPROVED' THEN 'verification' END
  ], NULL)
  FROM tutor t WHERE t.id = p_tutor;
$$;

-- A changed number is unverified until the new number is verified. An UPDATE that sets phone_verified_at
-- in the same statement (the verify flow) keeps its timestamp.
CREATE OR REPLACE FUNCTION phone_verified_reset() RETURNS trigger AS $$
BEGIN
  IF NEW.phone_number IS DISTINCT FROM OLD.phone_number
     AND NEW.phone_verified_at IS NOT DISTINCT FROM OLD.phone_verified_at THEN
    NEW.phone_verified_at := NULL;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER student_phone_verified_reset_trg BEFORE UPDATE OF phone_number ON student
  FOR EACH ROW EXECUTE FUNCTION phone_verified_reset();
CREATE TRIGGER tutor_phone_verified_reset_trg BEFORE UPDATE OF phone_number ON tutor
  FOR EACH ROW EXECUTE FUNCTION phone_verified_reset();
