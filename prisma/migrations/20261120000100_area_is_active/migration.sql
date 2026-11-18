SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Admins deactivate areas instead of deleting them: students, tutors and requirements keep
-- referencing an inactive area, it only leaves GET /areas. A constant default is metadata-only on PG 11+.
ALTER TABLE "area" ADD COLUMN "is_active" BOOLEAN NOT NULL DEFAULT true;
