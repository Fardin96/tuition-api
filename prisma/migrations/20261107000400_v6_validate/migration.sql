-- v6 validate: scans existing rows under SHARE UPDATE EXCLUSIVE (reads and writes continue).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE student VALIDATE CONSTRAINT student_whatsapp_e164;
ALTER TABLE tutor VALIDATE CONSTRAINT tutor_whatsapp_e164;
ALTER TABLE student VALIDATE CONSTRAINT student_phone_e164;
ALTER TABLE tutor VALIDATE CONSTRAINT tutor_phone_e164;
ALTER TABLE tutor VALIDATE CONSTRAINT tutor_zone_limit;
ALTER TABLE tuition_requirement VALIDATE CONSTRAINT req_days_valid;
ALTER TABLE tutor_location VALIDATE CONSTRAINT tloc_in_bd;
ALTER TABLE student_location VALIDATE CONSTRAINT sloc_in_bd;
ALTER TABLE application VALIDATE CONSTRAINT app_match_score_range;

-- fee_payment is append-only, so bad legacy rows cannot be fixed. Stay NOT VALID (still enforced for new rows) in that case.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM fee_payment WHERE method NOT IN ('SSLCOMMERZ', 'CASH')) THEN
    ALTER TABLE fee_payment VALIDATE CONSTRAINT fee_payment_method_allowed;
  ELSE
    RAISE NOTICE 'fee_payment_method_allowed stays NOT VALID: legacy fee_payment rows use other methods and the ledger is append-only';
  END IF;
END $$;
