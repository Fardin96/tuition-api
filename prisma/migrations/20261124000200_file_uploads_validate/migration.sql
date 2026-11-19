SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Validate the NOT VALID foreign key from 20261124000100_file_uploads (SHARE UPDATE EXCLUSIVE, writes keep flowing).
ALTER TABLE "student" VALIDATE CONSTRAINT "student_verification_reviewed_by_fkey";
