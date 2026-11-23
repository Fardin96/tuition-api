SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Admin business dashboard: a daily activity log (for MAU and DAU) and each admin's widget layout.

-- One row per account per Dhaka day it signed in or refreshed a session. Written by the trigger below.
CREATE TABLE "account_activity_day" (
    "account_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    CONSTRAINT "account_activity_day_pkey" PRIMARY KEY ("account_id", "day"),
    CONSTRAINT "account_activity_day_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Plain (not CONCURRENTLY): the migration runs as one script, and the table is new and empty.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "account_activity_day_day_idx" ON "account_activity_day"("day");

-- An admin's dashboard: widget ids in order. No row means the defaults.
CREATE TABLE "admin_dashboard_layout" (
    "account_id" UUID NOT NULL,
    "widgets" JSONB NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "admin_dashboard_layout_pkey" PRIMARY KEY ("account_id"),
    CONSTRAINT "admin_dashboard_layout_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "admin_dashboard_layout_widgets_shape" CHECK (jsonb_typeof("widgets") = 'array' AND jsonb_array_length("widgets") BETWEEN 1 AND 24)
);

-- Every sign-in and every refresh inserts a session row, so a session insert is the activity signal.
-- Activity is best-effort: auth must not fail because of it, so an error is logged and the session insert goes on.
CREATE OR REPLACE FUNCTION record_account_activity() RETURNS trigger AS $$
BEGIN
  INSERT INTO account_activity_day (account_id, day)
  VALUES (NEW.account_id, (NEW.created_at AT TIME ZONE 'Asia/Dhaka')::date)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'record_account_activity failed: %', SQLERRM;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER session_record_activity_trg AFTER INSERT ON session
  FOR EACH ROW EXECUTE FUNCTION record_account_activity();

-- History from the sessions still stored (expired ones are cleaned up, so this reaches back only that far).
INSERT INTO account_activity_day (account_id, day)
SELECT account_id, (created_at AT TIME ZONE 'Asia/Dhaka')::date FROM session
ON CONFLICT DO NOTHING;
