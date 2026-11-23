SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Profile pictures: an uploaded AVATAR file that an account shows, and the picture Google sent at sign-in.

-- New values are only used by later transactions, which PostgreSQL 12+ allows inside one migration.
ALTER TYPE "FilePurpose" ADD VALUE 'AVATAR' AFTER 'STORY_VIDEO';

-- Both columns are new and nullable, with no default, so nothing is rewritten.
ALTER TABLE "account" ADD COLUMN "avatar_file_id" UUID;
ALTER TABLE "account" ADD COLUMN "google_picture_url" TEXT;

-- Plain (not CONCURRENTLY): the migration runs as one script, and the column was just added, so every row is NULL.
-- squawk-ignore require-concurrent-index-creation
CREATE UNIQUE INDEX "account_avatar_file_id_key" ON "account"("avatar_file_id");

-- NOT VALID here, validated in 20261201000200_avatars_validate (the column is new and all NULL).
ALTER TABLE "account" ADD CONSTRAINT "account_avatar_file_id_fkey" FOREIGN KEY ("avatar_file_id") REFERENCES "file_asset"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
