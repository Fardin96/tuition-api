SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Upload moderation: notes an admin can keep private, a per-user upload history, upload blocks,
-- and in-app alerts that are not about an application.

CREATE TYPE "UploadReviewAction" AS ENUM ('APPROVED', 'REJECTED', 'REVOKED', 'REMOVED', 'BLOCKED', 'UNBLOCKED');

-- New values are only used by later transactions, which PostgreSQL 12+ allows inside one migration.
ALTER TYPE "AppNotificationKind" ADD VALUE 'ID_APPROVED' AFTER 'PACKAGE_CLOSED';
ALTER TYPE "AppNotificationKind" ADD VALUE 'ID_REJECTED' AFTER 'ID_APPROVED';
ALTER TYPE "AppNotificationKind" ADD VALUE 'VIDEO_APPROVED' AFTER 'ID_REJECTED';
ALTER TYPE "AppNotificationKind" ADD VALUE 'VIDEO_REJECTED' AFTER 'VIDEO_APPROVED';
ALTER TYPE "AppNotificationKind" ADD VALUE 'FILE_REMOVED' AFTER 'VIDEO_REJECTED';
ALTER TYPE "AppNotificationKind" ADD VALUE 'UPLOADS_BLOCKED' AFTER 'FILE_REMOVED';
ALTER TYPE "AppNotificationKind" ADD VALUE 'UPLOADS_UNBLOCKED' AFTER 'UPLOADS_BLOCKED';

-- Alerts about uploads have no application. Existing rows all have one.
ALTER TABLE "app_notification" ADD COLUMN "note" TEXT;
ALTER TABLE "app_notification" ADD COLUMN "file_purpose" "FilePurpose";
ALTER TABLE "app_notification" ADD COLUMN "blocks_videos" BOOLEAN;
ALTER TABLE "app_notification" ADD COLUMN "blocks_documents" BOOLEAN;
-- Old clients only read alerts through the API, which still returns application alerts unchanged.
-- squawk-ignore ban-drop-not-null
ALTER TABLE "app_notification" ALTER COLUMN "application_id" DROP NOT NULL;

-- Application kinds must name an application and upload kinds must not. NOT VALID here (existing
-- rows are checked in 20261126000200_upload_moderation_validate without a long lock).
ALTER TABLE "app_notification" ADD CONSTRAINT "app_notification_application_shape" CHECK (
  (application_id IS NOT NULL) = (kind::text IN (
    'APPLICATION_RECEIVED', 'PACKAGE_REQUESTED', 'APPLICATION_ACCEPTED', 'APPLICATION_DECLINED',
    'LISTING_FILLED', 'APPLICATION_WITHDRAWN', 'APPLICATION_REOPENED', 'APPLICATION_CANCELLED',
    'APPLICATION_COMPLETED', 'PACKAGE_UPDATED', 'PACKAGE_CLOSED'))
) NOT VALID;

-- Whether the user sees the admin's note. Existing notes were always shown.
ALTER TABLE "tutor_verification" ADD COLUMN "note_visible" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "student" ADD COLUMN "verification_note_visible" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "tutor_video" ADD COLUMN "note_visible" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "upload_review" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "file_id" UUID,
    "purpose" "FilePurpose",
    "file_name" TEXT,
    "content_type" TEXT,
    -- squawk-ignore prefer-bigint-over-int
    "size_bytes" INTEGER,
    "action" "UploadReviewAction" NOT NULL,
    "note" TEXT,
    "note_visible" BOOLEAN NOT NULL DEFAULT true,
    "actor_account_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "upload_review_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "upload_review_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "upload_review_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "file_asset"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "upload_review_actor_account_id_fkey" FOREIGN KEY ("actor_account_id") REFERENCES "admin_user"("account_id") ON DELETE SET NULL ON UPDATE CASCADE,
    -- Everything but an approval or a lifted block says why.
    CONSTRAINT "upload_review_note_present" CHECK (
      action IN ('APPROVED', 'UNBLOCKED') OR (note IS NOT NULL AND length(btrim(note)) > 0)),
    -- Block rows are about the account, every other row about one file.
    CONSTRAINT "upload_review_file_shape" CHECK (
      (action IN ('BLOCKED', 'UNBLOCKED')) = (purpose IS NULL))
);

CREATE TABLE "upload_block" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "blocks_videos" BOOLEAN NOT NULL,
    "blocks_documents" BOOLEAN NOT NULL,
    "note" TEXT NOT NULL,
    "note_visible" BOOLEAN NOT NULL DEFAULT true,
    "blocked_by" UUID,
    "blocked_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unblocked_at" TIMESTAMPTZ(3),
    "unblocked_by" UUID,

    CONSTRAINT "upload_block_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "upload_block_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "upload_block_blocked_by_fkey" FOREIGN KEY ("blocked_by") REFERENCES "admin_user"("account_id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "upload_block_unblocked_by_fkey" FOREIGN KEY ("unblocked_by") REFERENCES "admin_user"("account_id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "upload_block_scope" CHECK (blocks_videos OR blocks_documents),
    CONSTRAINT "upload_block_note_present" CHECK (length(btrim(note)) > 0)
);

-- The tables are new and empty, so plain CREATE INDEX takes no meaningful lock.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "upload_review_account_id_created_at_idx" ON "upload_review"("account_id", "created_at" DESC);
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "upload_review_file_id_idx" ON "upload_review"("file_id");
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "upload_review_actor_account_id_idx" ON "upload_review"("actor_account_id");
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "upload_block_account_id_blocked_at_idx" ON "upload_block"("account_id", "blocked_at" DESC);
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "upload_block_blocked_by_idx" ON "upload_block"("blocked_by");
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "upload_block_unblocked_by_idx" ON "upload_block"("unblocked_by");
-- At most one active block per account (protected: never accept a DROP INDEX for it).
-- squawk-ignore require-concurrent-index-creation
CREATE UNIQUE INDEX "upload_block_one_active" ON "upload_block"("account_id") WHERE unblocked_at IS NULL;
