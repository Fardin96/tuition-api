SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Pre-flight: a number may belong to one account only (phone or WhatsApp, student or tutor).
DO $$
DECLARE
  dup_count integer;
BEGIN
  SELECT count(*) INTO dup_count FROM (
    SELECT n
    FROM (
      SELECT account_id, phone_number AS n FROM student
      UNION ALL SELECT account_id, whatsapp_number FROM student
      UNION ALL SELECT account_id, phone_number FROM tutor
      UNION ALL SELECT account_id, whatsapp_number FROM tutor
    ) numbers
    WHERE n IS NOT NULL AND n NOT LIKE 'deleted:%'
    GROUP BY n
    HAVING count(DISTINCT account_id) > 1
  ) dups;

  IF dup_count > 0 THEN
    RAISE EXCEPTION 'contact_number_unique pre-flight failed: % phone/WhatsApp number(s) are used by more than one account. Resolve them (SELECT the numbers grouped by value across student and tutor) and re-run the migration.', dup_count;
  END IF;
END $$;

-- Phone and WhatsApp numbers are unique across all accounts, not per table.
-- Serialised per number with an advisory lock, so two concurrent inserts cannot both pass.
CREATE OR REPLACE FUNCTION contact_number_guard() RETURNS trigger AS $$
DECLARE
  n text;
BEGIN
  FOR n IN
    SELECT DISTINCT v FROM (VALUES (NEW.phone_number), (NEW.whatsapp_number)) AS t(v)
    WHERE v IS NOT NULL AND v NOT LIKE 'deleted:%'
    ORDER BY v
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('contact:' || n, 0));
    IF EXISTS (
      SELECT 1 FROM student
      WHERE account_id <> NEW.account_id AND (phone_number = n OR whatsapp_number = n)
      UNION ALL
      SELECT 1 FROM tutor
      WHERE account_id <> NEW.account_id AND (phone_number = n OR whatsapp_number = n)
    ) THEN
      RAISE EXCEPTION 'contact_number_in_use' USING ERRCODE = 'unique_violation', CONSTRAINT = 'contact_number_unique';
    END IF;
  END LOOP;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- Named *_guard_trg so they sort after the *_phone_fill_trg triggers (BEFORE triggers fire alphabetically),
-- so phone_number is already filled in when the guard reads it.
CREATE TRIGGER student_phone_guard_trg BEFORE INSERT OR UPDATE OF phone_number, whatsapp_number ON student
  FOR EACH ROW EXECUTE FUNCTION contact_number_guard();
CREATE TRIGGER tutor_phone_guard_trg BEFORE INSERT OR UPDATE OF phone_number, whatsapp_number ON tutor
  FOR EACH ROW EXECUTE FUNCTION contact_number_guard();
