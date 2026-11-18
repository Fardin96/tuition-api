SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- File uploads: the uploader's file name and the public-bucket copy marker.
ALTER TABLE "file_asset" ADD COLUMN "original_name" TEXT;
ALTER TABLE "file_asset" ADD COLUMN "published_at" TIMESTAMPTZ(3);

-- Student ID review: who decided the latest submission, when, and why.
ALTER TABLE "student" ADD COLUMN "verification_submitted_at" TIMESTAMPTZ(3);
ALTER TABLE "student" ADD COLUMN "verification_decided_at" TIMESTAMPTZ(3);
ALTER TABLE "student" ADD COLUMN "verification_reviewed_by" UUID;
ALTER TABLE "student" ADD COLUMN "verification_note" TEXT;

-- NOT VALID here, validated in 20261124000200_file_uploads_validate (the column is new and all NULL).
ALTER TABLE "student" ADD CONSTRAINT "student_verification_reviewed_by_fkey"
  FOREIGN KEY ("verification_reviewed_by") REFERENCES "admin_user"("account_id")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
