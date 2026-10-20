-- constraints.sql  (schema v5)
-- Rules schema.prisma cannot express: CHECKs, triggers, partial indexes, append-only tables.
-- Workflow:
--   1. npx prisma migrate dev --create-only --name init   (generates table DDL)
--   2. Paste this file at the END of the generated migration.sql
--   3. npx prisma migrate dev                             (applies it)
-- On every later `migrate dev`, READ the generated SQL before accepting it.
-- Prisma does not model CHECKs, triggers or partial unique indexes and may
-- propose dropping the partial indexes. Never accept a DROP INDEX for the
-- indexes named below.
-- Needs PostgreSQL 13+ (plpgsql only).
--
-- v5 changes are marked [v5].

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ═════════ 1. One account = one role = at most one profile ═════════════
-- Each profile row carries a fixed role and a composite FK (account_id, role)
-- to account (id, role) (declared in schema.prisma). These CHECKs pin the role.
ALTER TABLE student    ADD CONSTRAINT student_role_fixed    CHECK (role = 'STUDENT');
ALTER TABLE tutor      ADD CONSTRAINT tutor_role_fixed      CHECK (role = 'TUTOR');
ALTER TABLE admin_user ADD CONSTRAINT admin_user_role_fixed CHECK (role = 'ADMIN');

-- Consent is two columns, not a table. Required for everyone except admins.
ALTER TABLE account ADD CONSTRAINT account_consent_recorded
  CHECK (role = 'ADMIN' OR (consent_accepted_at IS NOT NULL AND consent_version IS NOT NULL));

-- [v5] deleted_at and status = DELETED must agree.
ALTER TABLE account ADD CONSTRAINT account_deleted_matches
  CHECK ((status = 'DELETED') = (deleted_at IS NOT NULL));

-- ═════════ 2. WhatsApp numbers: E.164 text, e.g. +8801712345678 ═══════
ALTER TABLE student ADD CONSTRAINT student_whatsapp_e164
  CHECK (whatsapp_number ~ '^\+[1-9][0-9]{7,14}$');
ALTER TABLE tutor ADD CONSTRAINT tutor_whatsapp_e164
  CHECK (whatsapp_number ~ '^\+[1-9][0-9]{7,14}$');

-- ═════════ 3. Value ranges and state shapes ════════════════════════════
ALTER TABLE tuition_requirement
  ADD CONSTRAINT requirement_class_level_range CHECK (class_level BETWEEN 1 AND 20),
  ADD CONSTRAINT requirement_days_range        CHECK (days_per_week BETWEEN 1 AND 7),
  ADD CONSTRAINT requirement_salary_positive   CHECK (salary > 0),
  ADD CONSTRAINT requirement_students_min      CHECK (student_count >= 1);

ALTER TABLE tuition_package
  ADD CONSTRAINT package_class_level_range CHECK (class_level BETWEEN 1 AND 20),
  ADD CONSTRAINT package_days_range        CHECK (days_per_week BETWEEN 1 AND 7),
  ADD CONSTRAINT package_salary_positive   CHECK (expected_salary > 0),
  ADD CONSTRAINT package_students_min      CHECK (student_count >= 1);

ALTER TABLE review     ADD CONSTRAINT review_rating_range CHECK (rating BETWEEN 1 AND 5);

-- [v5] file lifecycle timestamps agree with status.
ALTER TABLE file_asset
  ADD CONSTRAINT file_size_positive       CHECK (size_bytes > 0),
  ADD CONSTRAINT file_uploaded_has_time   CHECK (status <> 'UPLOADED' OR uploaded_at IS NOT NULL),
  ADD CONSTRAINT file_deleted_has_time    CHECK (status <> 'DELETED'  OR deleted_at  IS NOT NULL);

-- [v5] a student who submitted verification must have a file.
ALTER TABLE student ADD CONSTRAINT student_verification_has_file
  CHECK (verification_status = 'NOT_SUBMITTED' OR verification_file_id IS NOT NULL);

-- [v5] published posts have a publish date.
ALTER TABLE blog_post ADD CONSTRAINT blog_published_has_date
  CHECK (status <> 'PUBLISHED' OR published_at IS NOT NULL);

-- A tutor is listed in the directory only once verified.
ALTER TABLE tutor ADD CONSTRAINT tutor_listed_requires_verified
  CHECK (NOT is_listed OR verification_status = 'APPROVED');

-- ═════════ 4. Ratings can never disagree with the review rows ══════════
-- (a) shape: no average without reviews, no reviews without an average
ALTER TABLE tutor ADD CONSTRAINT tutor_rating_shape
  CHECK ((rating_count = 0 AND rating_avg = 0)
      OR (rating_count > 0 AND rating_avg BETWEEN 1 AND 5));
ALTER TABLE student ADD CONSTRAINT student_rating_shape
  CHECK ((rating_count = 0 AND rating_avg = 0)
      OR (rating_count > 0 AND rating_avg BETWEEN 1 AND 5));

-- (b) review eligibility and immutability
CREATE OR REPLACE FUNCTION review_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM application a
      WHERE a.tutor_id = NEW.tutor_id AND a.student_id = NEW.student_id
        AND a.status IN ('CONFIRMED', 'COMPLETED')
    ) THEN
      RAISE EXCEPTION 'review requires a confirmed or completed application between this tutor and student';
    END IF;
  ELSE
    IF NEW.tutor_id <> OLD.tutor_id OR NEW.student_id <> OLD.student_id OR NEW.direction <> OLD.direction THEN
      RAISE EXCEPTION 'review tutor, student and direction cannot change';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER review_guard_trg BEFORE INSERT OR UPDATE ON review
  FOR EACH ROW EXECUTE FUNCTION review_guard();

-- (c) recompute from the rows on every change, in the same transaction
-- [v5] explicit IF instead of CASE over OLD/NEW (safer across PG versions).
CREATE OR REPLACE FUNCTION review_recompute() RETURNS trigger AS $$
DECLARE r review%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  IF r.direction = 'STUDENT_TO_TUTOR' THEN
    UPDATE tutor SET
      rating_count = (SELECT count(*) FROM review WHERE tutor_id = r.tutor_id AND direction = 'STUDENT_TO_TUTOR' AND status = 'VISIBLE'),
      rating_avg   = COALESCE((SELECT round(avg(rating), 2) FROM review WHERE tutor_id = r.tutor_id AND direction = 'STUDENT_TO_TUTOR' AND status = 'VISIBLE'), 0)
    WHERE id = r.tutor_id;
  ELSE
    UPDATE student SET
      rating_count = (SELECT count(*) FROM review WHERE student_id = r.student_id AND direction = 'TUTOR_TO_STUDENT' AND status = 'VISIBLE'),
      rating_avg   = COALESCE((SELECT round(avg(rating), 2) FROM review WHERE student_id = r.student_id AND direction = 'TUTOR_TO_STUDENT' AND status = 'VISIBLE'), 0)
    WHERE id = r.student_id;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER review_recompute_trg AFTER INSERT OR UPDATE OR DELETE ON review
  FOR EACH ROW EXECUTE FUNCTION review_recompute();

-- (d) application code cannot write the rating columns directly: they may only
-- change from inside the review trigger (trigger depth 2).
CREATE OR REPLACE FUNCTION rating_columns_guard() RETURNS trigger AS $$
BEGIN
  IF (NEW.rating_avg IS DISTINCT FROM OLD.rating_avg OR NEW.rating_count IS DISTINCT FROM OLD.rating_count)
     AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'rating_avg and rating_count are maintained by the review trigger';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER tutor_rating_guard   BEFORE UPDATE ON tutor   FOR EACH ROW EXECUTE FUNCTION rating_columns_guard();
CREATE TRIGGER student_rating_guard BEFORE UPDATE ON student FOR EACH ROW EXECUTE FUNCTION rating_columns_guard();

-- ═════════ 5. Applications ═════════════════════════════════════════════
-- Duplicates are blocked by the two UNIQUE keys in schema.prisma.
-- Must point at a requirement, a package, or both.
ALTER TABLE application ADD CONSTRAINT application_has_target
  CHECK (requirement_id IS NOT NULL OR package_id IS NOT NULL);

-- A tutor applies TO a requirement.
ALTER TABLE application ADD CONSTRAINT application_tutor_initiated_has_requirement
  CHECK (initiated_by <> 'TUTOR' OR requirement_id IS NOT NULL);

-- Optional, only if a student can NEVER start a match from a requirement
-- (e.g. by inviting a tutor). Uncomment to enforce "a student takes a package".
-- ALTER TABLE application ADD CONSTRAINT application_student_initiated_has_package
--   CHECK (initiated_by <> 'STUDENT' OR package_id IS NOT NULL);

-- confirmed_at / ended_at must agree with status.
ALTER TABLE application ADD CONSTRAINT application_confirmed_at_matches_status
  CHECK (
    (status IN ('CONFIRMED', 'COMPLETED') AND confirmed_at IS NOT NULL)
    OR (status IN ('PENDING', 'REJECTED', 'WITHDRAWN', 'EXPIRED') AND confirmed_at IS NULL)
    OR status = 'CANCELLED'
  );
ALTER TABLE application ADD CONSTRAINT application_completed_has_end
  CHECK (status <> 'COMPLETED' OR ended_at IS NOT NULL);
ALTER TABLE application ADD CONSTRAINT application_live_has_no_end
  CHECK (status NOT IN ('PENDING', 'CONFIRMED') OR ended_at IS NULL);

-- [v5] Ownership: the requirement must belong to this student, the package to
-- this tutor. Replaces the composite FKs, which Prisma cannot model when one
-- column is nullable.
CREATE OR REPLACE FUNCTION application_target_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.requirement_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM tuition_requirement r WHERE r.id = NEW.requirement_id AND r.student_id = NEW.student_id
  ) THEN
    RAISE EXCEPTION 'requirement does not belong to this student';
  END IF;
  IF NEW.package_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM tuition_package p WHERE p.id = NEW.package_id AND p.tutor_id = NEW.tutor_id
  ) THEN
    RAISE EXCEPTION 'package does not belong to this tutor';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER application_target_guard_trg
  BEFORE INSERT OR UPDATE OF requirement_id, package_id, tutor_id, student_id ON application
  FOR EACH ROW EXECUTE FUNCTION application_target_guard();

-- Confirmation history is never erased. Reopening an application (retry) is
-- only possible for a row that never reached CONFIRMED; a confirmed or
-- completed match keeps its confirmed_at / ended_at forever. (Together with the
-- status CHECK above, a row with confirmed_at can never return to PENDING,
-- REJECTED, WITHDRAWN or EXPIRED.)
CREATE OR REPLACE FUNCTION application_history_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.confirmed_at IS NOT NULL AND NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at THEN
    RAISE EXCEPTION 'confirmed_at is match history and cannot change';
  END IF;
  IF OLD.ended_at IS NOT NULL AND NEW.ended_at IS DISTINCT FROM OLD.ended_at THEN
    RAISE EXCEPTION 'ended_at is match history and cannot change';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER application_history_guard_trg BEFORE UPDATE ON application
  FOR EACH ROW EXECUTE FUNCTION application_history_guard();

-- ═════════ 6. Tutor verification ═══════════════════════════════════════
CREATE UNIQUE INDEX tutor_verification_one_pending
  ON tutor_verification (tutor_id) WHERE status = 'PENDING';

-- [v5] a submission row is PENDING, APPROVED or REJECTED (never NOT_SUBMITTED);
-- a decision records who and when; a rejection explains why.
ALTER TABLE tutor_verification
  ADD CONSTRAINT tv_status_valid CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  ADD CONSTRAINT tv_decision_shape CHECK (
    (status = 'PENDING' AND decided_at IS NULL)
    OR (status IN ('APPROVED', 'REJECTED') AND decided_at IS NOT NULL AND reviewed_by IS NOT NULL)),
  ADD CONSTRAINT tv_rejection_has_note CHECK (
    status <> 'REJECTED' OR (note IS NOT NULL AND length(btrim(note)) > 0));

-- [v5] tutor.verification_status is the latest submission's status, always.
-- If it stops being APPROVED the tutor is delisted in the same statement.
-- (Note: a new PENDING resubmission after an approval delists the tutor until
-- it is decided. Change the ORDER BY / filter here if you want to stay listed.)
CREATE OR REPLACE FUNCTION tutor_verification_sync() RETURNS trigger AS $$
DECLARE latest "VerificationStatus";
BEGIN
  SELECT status INTO latest FROM tutor_verification
    WHERE tutor_id = NEW.tutor_id ORDER BY submitted_at DESC, id DESC LIMIT 1;
  UPDATE tutor SET
    verification_status = latest,
    is_listed = is_listed AND latest = 'APPROVED'
  WHERE id = NEW.tutor_id;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER tutor_verification_sync_trg AFTER INSERT OR UPDATE OF status ON tutor_verification
  FOR EACH ROW EXECUTE FUNCTION tutor_verification_sync();

-- ═════════ 7. Fees and payments ════════════════════════════════════════
ALTER TABLE platform_fee
  ADD CONSTRAINT fee_amount_due_positive CHECK (amount_due > 0),
  ADD CONSTRAINT fee_paid_in_range       CHECK (amount_paid >= 0 AND amount_paid <= amount_due),
  -- status must always agree with amount_paid (WAIVED / VOID are admin overrides)
  ADD CONSTRAINT fee_status_matches_paid CHECK (
    status IN ('WAIVED', 'VOID')
    OR (status = 'DUE'     AND amount_paid = 0)
    OR (status = 'PARTIAL' AND amount_paid > 0 AND amount_paid < amount_due)
    OR (status = 'PAID'    AND amount_paid = amount_due)
  );

CREATE UNIQUE INDEX platform_fee_one_placement_per_application
  ON platform_fee (application_id) WHERE fee_type = 'PLACEMENT' AND status <> 'VOID';

-- [v5] the fee's tutor must be the application's tutor.
CREATE OR REPLACE FUNCTION platform_fee_guard() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM application a WHERE a.id = NEW.application_id AND a.tutor_id = NEW.tutor_id) THEN
    RAISE EXCEPTION 'fee tutor must be the tutor of the application';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER platform_fee_guard_trg BEFORE INSERT OR UPDATE OF tutor_id, application_id ON platform_fee
  FOR EACH ROW EXECUTE FUNCTION platform_fee_guard();

ALTER TABLE fee_payment
  ADD CONSTRAINT payment_amount_positive CHECK (amount > 0),
  ADD CONSTRAINT payment_reversal_shape CHECK (
    (kind = 'PAYMENT'  AND reverses_payment_id IS NULL)
    OR (kind = 'REVERSAL' AND reverses_payment_id IS NOT NULL AND reason IS NOT NULL AND length(btrim(reason)) > 0)
  );

-- Validate every new ledger row.
-- [v5] (1) an advisory lock on the transaction reference closes the race where
-- two concurrent inserts on DIFFERENT fees record the same TrxID (the fee row
-- lock only serialises payments on the same fee); (2) a PAYMENT can no longer
-- exceed what is still due (clear error instead of a CHECK failure later).
CREATE OR REPLACE FUNCTION fee_payment_before_insert() RETURNS trigger AS $$
DECLARE f platform_fee%ROWTYPE; orig fee_payment%ROWTYPE; reversed numeric;
BEGIN
  IF NEW.kind = 'PAYMENT' AND NEW.txn_reference IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.method::text || ':' || NEW.txn_reference, 0));
  END IF;

  SELECT * INTO f FROM platform_fee WHERE id = NEW.fee_id FOR UPDATE;   -- serialises payments per fee
  IF f.status IN ('WAIVED', 'VOID') THEN
    RAISE EXCEPTION 'cannot record a payment on a % fee', f.status;
  END IF;

  IF NEW.kind = 'REVERSAL' THEN
    SELECT * INTO orig FROM fee_payment WHERE id = NEW.reverses_payment_id;
    IF orig.id IS NULL OR orig.kind <> 'PAYMENT' OR orig.fee_id <> NEW.fee_id THEN
      RAISE EXCEPTION 'a reversal must point at a payment on the same fee';
    END IF;
    SELECT COALESCE(sum(amount), 0) INTO reversed FROM fee_payment WHERE reverses_payment_id = orig.id;
    IF reversed + NEW.amount > orig.amount THEN
      RAISE EXCEPTION 'reversals exceed the original payment amount';
    END IF;
  ELSE
    IF f.amount_paid + NEW.amount > f.amount_due THEN
      RAISE EXCEPTION 'payment exceeds the amount still due (%)', f.amount_due - f.amount_paid;
    END IF;
    IF NEW.txn_reference IS NOT NULL AND EXISTS (
      -- the same bKash/Nagad transaction id cannot be recorded twice, unless that payment was fully reversed
      SELECT 1 FROM fee_payment p
      WHERE p.kind = 'PAYMENT' AND p.method = NEW.method AND p.txn_reference = NEW.txn_reference
        AND p.amount > COALESCE((SELECT sum(r.amount) FROM fee_payment r WHERE r.reverses_payment_id = p.id), 0)
    ) THEN
      RAISE EXCEPTION 'transaction reference % already recorded for %', NEW.txn_reference, NEW.method;
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER fee_payment_before_insert_trg BEFORE INSERT ON fee_payment
  FOR EACH ROW EXECUTE FUNCTION fee_payment_before_insert();

-- After every ledger row: recompute amount_paid and status in the same transaction.
CREATE OR REPLACE FUNCTION fee_recompute() RETURNS trigger AS $$
DECLARE paid numeric; due numeric;
BEGIN
  SELECT COALESCE(sum(CASE kind WHEN 'PAYMENT' THEN amount ELSE -amount END), 0) INTO paid
    FROM fee_payment WHERE fee_id = NEW.fee_id;
  SELECT amount_due INTO due FROM platform_fee WHERE id = NEW.fee_id;
  UPDATE platform_fee SET
    amount_paid = paid,
    status = CASE WHEN paid = 0 THEN 'DUE'::"FeeStatus"
                  WHEN paid < due THEN 'PARTIAL'::"FeeStatus"
                  ELSE 'PAID'::"FeeStatus" END
  WHERE id = NEW.fee_id;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER fee_recompute_trg AFTER INSERT ON fee_payment
  FOR EACH ROW EXECUTE FUNCTION fee_recompute();

-- amount_paid can only change from inside that trigger.
CREATE OR REPLACE FUNCTION fee_paid_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.amount_paid IS DISTINCT FROM OLD.amount_paid AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'amount_paid is maintained from fee_payment rows';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER fee_paid_guard_trg BEFORE UPDATE ON platform_fee
  FOR EACH ROW EXECUTE FUNCTION fee_paid_guard();

-- ═════════ 8. Admin levels ═════════════════════════════════════════════
-- super_admin_email holds the two allowed emails (slots 1 and 2).
ALTER TABLE super_admin_email ADD CONSTRAINT super_admin_slot CHECK (slot IN (1, 2));

ALTER TABLE admin_user
  ADD CONSTRAINT admin_no_self_approval CHECK (approved_by IS DISTINCT FROM account_id),
  ADD CONSTRAINT admin_no_self_removal  CHECK (removed_by  IS DISTINCT FROM account_id),
  -- ACTIVE needs an approval, except the allowlisted super admins who seed themselves
  ADD CONSTRAINT admin_active_needs_approval CHECK (
    status <> 'ACTIVE' OR admin_role = 'SUPER_ADMIN' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
  ADD CONSTRAINT admin_removed_has_remover CHECK (
    status <> 'REMOVED' OR (removed_by IS NOT NULL AND removed_at IS NOT NULL)),
  -- a super admin can never be removed
  ADD CONSTRAINT admin_super_never_removed CHECK (admin_role <> 'SUPER_ADMIN' OR status <> 'REMOVED');

CREATE OR REPLACE FUNCTION admin_user_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.admin_role = 'SUPER_ADMIN' AND NOT EXISTS (
    SELECT 1 FROM account a JOIN super_admin_email s ON lower(s.email) = lower(a.email)
    WHERE a.id = NEW.account_id
  ) THEN
    RAISE EXCEPTION 'only allowlisted emails can be SUPER_ADMIN';
  END IF;
  IF NEW.approved_by IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM admin_user s WHERE s.account_id = NEW.approved_by AND s.admin_role = 'SUPER_ADMIN' AND s.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'only an active super admin can approve admins';
  END IF;
  IF NEW.removed_by IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM admin_user s WHERE s.account_id = NEW.removed_by AND s.admin_role = 'SUPER_ADMIN' AND s.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'only an active super admin can remove admins';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER admin_user_guard_trg BEFORE INSERT OR UPDATE ON admin_user
  FOR EACH ROW EXECUTE FUNCTION admin_user_guard();

-- ═════════ 9. Blocking (super admin only) ══════════════════════════════
ALTER TABLE account_block
  ADD CONSTRAINT block_no_self CHECK (blocked_by <> account_id),
  ADD CONSTRAINT block_unblock_shape CHECK ((unblocked_at IS NULL) = (unblocked_by IS NULL)),
  ADD CONSTRAINT block_reason_present CHECK (length(btrim(reason)) > 0);

-- At most one active block per account.
CREATE UNIQUE INDEX account_block_one_active ON account_block (account_id) WHERE unblocked_at IS NULL;

CREATE OR REPLACE FUNCTION account_block_guard() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin_user s WHERE s.account_id = NEW.blocked_by AND s.admin_role = 'SUPER_ADMIN' AND s.status = 'ACTIVE') THEN
    RAISE EXCEPTION 'only an active super admin can block';
  END IF;
  IF NEW.unblocked_by IS NOT NULL AND NOT EXISTS (SELECT 1 FROM admin_user s WHERE s.account_id = NEW.unblocked_by AND s.admin_role = 'SUPER_ADMIN' AND s.status = 'ACTIVE') THEN
    RAISE EXCEPTION 'only an active super admin can unblock';
  END IF;
  IF EXISTS (SELECT 1 FROM admin_user u WHERE u.account_id = NEW.account_id AND u.admin_role = 'SUPER_ADMIN') THEN
    RAISE EXCEPTION 'a super admin cannot be blocked';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER account_block_guard_trg BEFORE INSERT OR UPDATE ON account_block
  FOR EACH ROW EXECUTE FUNCTION account_block_guard();

-- Keep account.status in step with the block history.
CREATE OR REPLACE FUNCTION account_block_sync() RETURNS trigger AS $$
BEGIN
  UPDATE account SET status = CASE
    WHEN EXISTS (SELECT 1 FROM account_block b WHERE b.account_id = NEW.account_id AND b.unblocked_at IS NULL) THEN 'BLOCKED'::"AccountStatus"
    ELSE 'ACTIVE'::"AccountStatus" END
  WHERE id = NEW.account_id AND status <> 'DELETED';
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER account_block_sync_trg AFTER INSERT OR UPDATE ON account_block
  FOR EACH ROW EXECUTE FUNCTION account_block_sync();

-- [v5] application code cannot set or clear BLOCKED directly; it can only change
-- from inside account_block_sync (trigger depth 2).
CREATE OR REPLACE FUNCTION account_status_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND (NEW.status = 'BLOCKED' OR OLD.status = 'BLOCKED')
     AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'BLOCKED status is maintained from account_block';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER account_status_guard_trg BEFORE UPDATE OF status ON account
  FOR EACH ROW EXECUTE FUNCTION account_status_guard();

-- [v5] a blocked or deleted account's tutor profile leaves the directory.
CREATE OR REPLACE FUNCTION account_unlist() RETURNS trigger AS $$
BEGIN
  UPDATE tutor SET is_listed = false WHERE account_id = NEW.id AND is_listed;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER account_unlist_trg AFTER UPDATE OF status ON account
  FOR EACH ROW WHEN (NEW.status <> 'ACTIVE' AND NEW.status IS DISTINCT FROM OLD.status)
  EXECUTE FUNCTION account_unlist();

-- ═════════ 10. Reports and disputes ════════════════════════════════════
ALTER TABLE report
  ADD CONSTRAINT report_not_self CHECK (reporter_id <> target_account_id),
  ADD CONSTRAINT report_closed_has_handler CHECK (
    status NOT IN ('RESOLVED', 'DISMISSED') OR (handled_by IS NOT NULL AND resolved_at IS NOT NULL));
-- One open report per reporter and target.
CREATE UNIQUE INDEX report_one_open_per_pair
  ON report (reporter_id, target_account_id) WHERE status IN ('OPEN', 'UNDER_REVIEW');

ALTER TABLE dispute
  ADD CONSTRAINT dispute_not_self CHECK (raised_by <> against),
  ADD CONSTRAINT dispute_closed_has_handler CHECK (
    status NOT IN ('RESOLVED', 'DISMISSED') OR (handled_by IS NOT NULL AND resolved_at IS NOT NULL));
CREATE UNIQUE INDEX dispute_one_open_per_raiser
  ON dispute (application_id, raised_by) WHERE status IN ('OPEN', 'UNDER_REVIEW');

-- Only the two parties of a running match can dispute it.
CREATE OR REPLACE FUNCTION dispute_guard() RETURNS trigger AS $$
DECLARE t_acc uuid; s_acc uuid; st "ApplicationStatus";
BEGIN
  SELECT t.account_id, s.account_id, a.status INTO t_acc, s_acc, st
    FROM application a JOIN tutor t ON t.id = a.tutor_id JOIN student s ON s.id = a.student_id
    WHERE a.id = NEW.application_id;
  IF st NOT IN ('CONFIRMED', 'COMPLETED') THEN
    RAISE EXCEPTION 'only a confirmed or completed match can be disputed';
  END IF;
  IF NOT ((NEW.raised_by = t_acc AND NEW.against = s_acc) OR (NEW.raised_by = s_acc AND NEW.against = t_acc)) THEN
    RAISE EXCEPTION 'dispute must be between the tutor and the student of this application';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER dispute_guard_trg BEFORE INSERT ON dispute
  FOR EACH ROW EXECUTE FUNCTION dispute_guard();

-- ═════════ 11. Outbox and search ═══════════════════════════════════════
-- [v5] SENDING is included: a worker that crashes mid-send leaves the row in
-- SENDING with next_attempt_at = claim time + lease, so it is picked up again.
CREATE INDEX notification_due_idx
  ON notification_log (next_attempt_at) WHERE status IN ('PENDING', 'FAILED', 'SENDING');

CREATE INDEX tutor_name_trgm ON tutor USING gin (name gin_trgm_ops);

-- ═════════ 12. Append-only tables ══════════════════════════════════════
-- audit_log and the payment ledger are never edited or deleted. Fix a wrong
-- payment with a REVERSAL row.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER audit_log_append_only   BEFORE UPDATE OR DELETE ON audit_log   FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER fee_payment_append_only BEFORE UPDATE OR DELETE ON fee_payment FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ═════════ 13. Seed (run once, from your seed script, not the migration) ═
-- INSERT INTO super_admin_email (slot, email) VALUES (1, 'first@example.com'), (2, 'second@example.com');
