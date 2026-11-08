-- v6 constraints: CHECKs on existing tables are NOT VALID here and validated in 20261107000400_v6_validate.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Listing is decided by recompute_is_listed() only; verification is optional unless the setting is on.
ALTER TABLE tutor DROP CONSTRAINT tutor_listed_requires_verified;

-- Phone number: backfilled in 02, now required and unique per table.
ALTER TABLE student ALTER COLUMN phone_number SET NOT NULL;
ALTER TABLE tutor ALTER COLUMN phone_number SET NOT NULL;
CREATE UNIQUE INDEX "student_phone_number_key" ON "student"("phone_number");
CREATE UNIQUE INDEX "tutor_phone_number_key" ON "tutor"("phone_number");

-- Transitional: old code inserts without phone_number. Dropped by the contract migration after the feature release.
CREATE OR REPLACE FUNCTION phone_number_fill() RETURNS trigger AS $$
BEGIN
  NEW.phone_number := COALESCE(NEW.phone_number, NEW.whatsapp_number);
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER student_phone_fill_trg BEFORE INSERT ON student
  FOR EACH ROW EXECUTE FUNCTION phone_number_fill();
CREATE TRIGGER tutor_phone_fill_trg BEFORE INSERT ON tutor
  FOR EACH ROW EXECUTE FUNCTION phone_number_fill();

-- WhatsApp and phone: E.164, with the deleted:<accountId>:<original> tombstone allowed.
ALTER TABLE student DROP CONSTRAINT student_whatsapp_e164;
ALTER TABLE student ADD CONSTRAINT student_whatsapp_e164
  CHECK (whatsapp_number ~ '^\+[1-9][0-9]{7,14}$' OR whatsapp_number LIKE 'deleted:%') NOT VALID;
ALTER TABLE tutor DROP CONSTRAINT tutor_whatsapp_e164;
ALTER TABLE tutor ADD CONSTRAINT tutor_whatsapp_e164
  CHECK (whatsapp_number ~ '^\+[1-9][0-9]{7,14}$' OR whatsapp_number LIKE 'deleted:%') NOT VALID;
ALTER TABLE student ADD CONSTRAINT student_phone_e164
  CHECK (phone_number ~ '^\+[1-9][0-9]{7,14}$' OR phone_number LIKE 'deleted:%') NOT VALID;
ALTER TABLE tutor ADD CONSTRAINT tutor_phone_e164
  CHECK (phone_number ~ '^\+[1-9][0-9]{7,14}$' OR phone_number LIKE 'deleted:%') NOT VALID;

-- Platform settings: new table, so validated right away. A bad value can never break the casts in the functions below.
ALTER TABLE platform_setting ADD CONSTRAINT platform_setting_value_valid CHECK (
  CASE key
    WHEN 'require_tutor_verification' THEN jsonb_typeof(value) = 'boolean'
    WHEN 'require_phone_verification' THEN jsonb_typeof(value) = 'boolean'
    WHEN 'commission_percent' THEN
      CASE WHEN jsonb_typeof(value) = 'number' THEN (value #>> '{}')::numeric BETWEEN 0 AND 100 ELSE false END
    ELSE false
  END);

INSERT INTO platform_setting (key, value, updated_at) VALUES
  ('require_tutor_verification', 'false'::jsonb, now()),
  ('require_phone_verification', 'false'::jsonb, now())   -- flip to true when the OTP feature ships
ON CONFLICT (key) DO NOTHING;

-- Payments: SSLCOMMERZ and CASH only. Legacy rows are checked in 04.
ALTER TABLE fee_payment
  ADD CONSTRAINT fee_payment_method_allowed CHECK (method IN ('SSLCOMMERZ', 'CASH')) NOT VALID;
DROP INDEX IF EXISTS fee_payment_gateway_ref_uniq;
CREATE UNIQUE INDEX fee_payment_gateway_ref_uniq
  ON fee_payment (txn_reference) WHERE method = 'SSLCOMMERZ' AND kind = 'PAYMENT';

-- Tutor requirement: new table, validated right away.
ALTER TABLE tutor_requirement
  ADD CONSTRAINT tr_class_range CHECK (class_level_min >= 1 AND class_level_max <= 20 AND class_level_max >= class_level_min),
  ADD CONSTRAINT tr_time_window CHECK (time_to > time_from),
  ADD CONSTRAINT tr_days_valid  CHECK (available_days BETWEEN 1 AND 127),
  ADD CONSTRAINT tr_salary_pos  CHECK (min_salary IS NULL OR min_salary > 0),
  ADD CONSTRAINT tr_students    CHECK (max_students >= 1),
  ADD CONSTRAINT tr_default_active CHECK (NOT is_default OR is_active);

CREATE UNIQUE INDEX tutor_requirement_one_default ON tutor_requirement (tutor_id) WHERE is_default;

CREATE OR REPLACE FUNCTION tr_block_archive() RETURNS trigger AS $$
BEGIN
  IF OLD.is_active AND NOT NEW.is_active AND EXISTS (
    SELECT 1 FROM tuition_package p WHERE p.requirement_id = OLD.id AND p.status = 'OPEN'
  ) THEN
    RAISE EXCEPTION 'requirement is mapped to open packages' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER tr_block_archive_trg BEFORE UPDATE OF is_active ON tutor_requirement
  FOR EACH ROW EXECUTE FUNCTION tr_block_archive();

CREATE OR REPLACE FUNCTION package_requirement_same_tutor() RETURNS trigger AS $$
BEGIN
  IF NEW.requirement_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM tutor_requirement r
    WHERE r.id = NEW.requirement_id AND r.tutor_id = NEW.tutor_id AND r.is_active
  ) THEN
    RAISE EXCEPTION 'package requirement must be an active requirement of the same tutor'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER package_requirement_same_tutor_trg
  BEFORE INSERT OR UPDATE OF requirement_id ON tuition_package
  FOR EACH ROW EXECUTE FUNCTION package_requirement_same_tutor();

-- Teaching zones: new table, validated right away.
ALTER TABLE tutor_zone ALTER COLUMN center SET NOT NULL;
ALTER TABLE tutor_zone
  ADD CONSTRAINT zone_radius CHECK (radius_m BETWEEN 1000 AND 5000),
  ADD CONSTRAINT zone_in_bd CHECK (
    ST_Y(center::geometry) BETWEEN 20.5 AND 26.7 AND ST_X(center::geometry) BETWEEN 88.0 AND 92.7);
CREATE INDEX tutor_zone_center_gix ON tutor_zone USING gist (center);

ALTER TABLE tutor ADD CONSTRAINT tutor_zone_limit CHECK (zone_limit BETWEEN 1 AND 50) NOT VALID;

CREATE OR REPLACE FUNCTION tutor_zone_quota() RETURNS trigger AS $$
DECLARE v_limit smallint; v_count int;
BEGIN
  SELECT zone_limit INTO v_limit FROM tutor WHERE id = NEW.tutor_id FOR UPDATE;
  SELECT count(*) INTO v_count FROM tutor_zone WHERE tutor_id = NEW.tutor_id;
  IF v_count >= v_limit THEN
    RAISE EXCEPTION 'zone limit reached' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER tutor_zone_quota_trg BEFORE INSERT ON tutor_zone
  FOR EACH ROW EXECUTE FUNCTION tutor_zone_quota();

-- Zone limit requests: new table, validated right away.
ALTER TABLE zone_limit_request
  ADD CONSTRAINT zlr_limit_range CHECK (requested_limit BETWEEN 6 AND 50),
  ADD CONSTRAINT zlr_decision_consistent CHECK (
    (status = 'PENDING'  AND decided_at IS NULL AND decided_by IS NULL)
    OR (status <> 'PENDING' AND decided_at IS NOT NULL AND decided_by IS NOT NULL));
CREATE UNIQUE INDEX zlr_one_pending_per_tutor ON zone_limit_request (tutor_id) WHERE status = 'PENDING';

-- Weekdays on the student requirement, and pin sanity inside Bangladesh.
ALTER TABLE tuition_requirement
  ADD CONSTRAINT req_days_valid CHECK (available_days BETWEEN 1 AND 127) NOT VALID;
ALTER TABLE tutor_location ADD CONSTRAINT tloc_in_bd CHECK (geog IS NULL OR (
  ST_Y(geog::geometry) BETWEEN 20.5 AND 26.7 AND ST_X(geog::geometry) BETWEEN 88.0 AND 92.7)) NOT VALID;
ALTER TABLE student_location ADD CONSTRAINT sloc_in_bd CHECK (geog IS NULL OR (
  ST_Y(geog::geometry) BETWEEN 20.5 AND 26.7 AND ST_X(geog::geometry) BETWEEN 88.0 AND 92.7)) NOT VALID;

ALTER TABLE application ADD CONSTRAINT app_match_score_range
  CHECK (match_score IS NULL OR match_score BETWEEN 0 AND 100) NOT VALID;

-- Listing and apply-gate functions.
CREATE OR REPLACE FUNCTION recompute_is_listed(p_tutor uuid) RETURNS void LANGUAGE sql AS $$
  UPDATE tutor t SET is_listed = (
    a.status = 'ACTIVE'
    AND (NOT COALESCE((SELECT (value #>> '{}')::boolean FROM platform_setting
                       WHERE key = 'require_tutor_verification'), false)
         OR t.verification_status = 'APPROVED'))
  FROM account a WHERE a.id = t.account_id AND t.id = p_tutor;
$$;

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
                        WHERE key = 'require_phone_verification'), false)
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

-- Replaced functions and triggers from earlier sections.
CREATE OR REPLACE FUNCTION tutor_verification_sync() RETURNS trigger AS $$
DECLARE latest "VerificationStatus";
BEGIN
  SELECT status INTO latest FROM tutor_verification
    WHERE tutor_id = NEW.tutor_id ORDER BY submitted_at DESC, id DESC LIMIT 1;
  UPDATE tutor SET verification_status = latest WHERE id = NEW.tutor_id;
  PERFORM recompute_is_listed(NEW.tutor_id);
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION account_unlist() RETURNS trigger AS $$
BEGIN
  PERFORM recompute_is_listed(t.id) FROM tutor t WHERE t.account_id = NEW.id;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS account_unlist_trg ON account;
CREATE TRIGGER account_unlist_trg AFTER UPDATE OF status ON account
  FOR EACH ROW WHEN (NEW.status IS DISTINCT FROM OLD.status)
  EXECUTE FUNCTION account_unlist();

-- Last: bring is_listed in line with the new rules for every existing tutor.
SELECT recompute_is_listed(id) FROM tutor;
