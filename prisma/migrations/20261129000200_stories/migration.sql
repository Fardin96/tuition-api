SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Stories: testimonials that students and tutors send in, reviewed by an admin, and optionally put on the
-- landing page. Tutor videos get a landing consent time, so an admin can only use a video its tutor agreed to.

-- New values are only used by later transactions, which PostgreSQL 12+ allows inside one migration.
ALTER TYPE "FilePurpose" ADD VALUE 'STORY_IMAGE' AFTER 'SITE_VIDEO';
ALTER TYPE "FilePurpose" ADD VALUE 'STORY_VIDEO' AFTER 'STORY_IMAGE';
ALTER TYPE "AppNotificationKind" ADD VALUE 'STORY_APPROVED' AFTER 'REQUIREMENT_INVITED';
ALTER TYPE "AppNotificationKind" ADD VALUE 'STORY_REJECTED' AFTER 'STORY_APPROVED';

-- Set when the tutor agrees to show the approved video on the home page. Cleared by the tutor.
ALTER TABLE "tutor_video" ADD COLUMN "landing_consent_at" TIMESTAMPTZ(3);

CREATE TABLE "story" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "role" "Role" NOT NULL,
    "headline" TEXT,
    "body" TEXT NOT NULL,
    "image_file_id" UUID,
    "video_file_id" UUID,
    "consent_at" TIMESTAMPTZ(3) NOT NULL,
    "status" "ModerationStatus" NOT NULL DEFAULT 'PENDING',
    "moderation_note" TEXT,
    "note_visible" BOOLEAN NOT NULL DEFAULT true,
    "reviewed_by" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),

    CONSTRAINT "story_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "story_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "story_image_file_id_fkey" FOREIGN KEY ("image_file_id") REFERENCES "file_asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "story_video_file_id_fkey" FOREIGN KEY ("video_file_id") REFERENCES "file_asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "story_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "admin_user"("account_id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- A file belongs to one story at most.
    CONSTRAINT "story_image_file_id_key" UNIQUE ("image_file_id"),
    CONSTRAINT "story_video_file_id_key" UNIQUE ("video_file_id"),
    -- Students give a headline on one line; tutors give none and send no video.
    CONSTRAINT "story_headline_shape" CHECK (
      (role = 'STUDENT' AND headline IS NOT NULL AND length(btrim(headline)) BETWEEN 1 AND 85 AND headline !~ '[\r\n]')
      OR (role = 'TUTOR' AND headline IS NULL)),
    CONSTRAINT "story_video_student_only" CHECK (video_file_id IS NULL OR role = 'STUDENT'),
    CONSTRAINT "story_body_len" CHECK (
      length(btrim(body)) > 0 AND char_length(body) <= (CASE WHEN role = 'STUDENT' THEN 700 ELSE 300 END)),
    -- A decision time exists exactly when the story is no longer pending.
    CONSTRAINT "story_decided_shape" CHECK ((status = 'PENDING') = (decided_at IS NULL)),
    -- A rejection says why.
    CONSTRAINT "story_rejection_note" CHECK (
      status <> 'REJECTED' OR (moderation_note IS NOT NULL AND length(btrim(moderation_note)) > 0))
);

-- New, empty table: CONCURRENTLY cannot run inside the migration transaction, and nothing is locked.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "story_account_id_idx" ON "story"("account_id");
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "story_status_created_at_idx" ON "story"("status", "created_at" DESC);
-- At most one pending story per account. Protected: never accept a DROP INDEX for it.
-- squawk-ignore require-concurrent-index-creation
CREATE UNIQUE INDEX "story_one_pending_per_account" ON "story"("account_id") WHERE "status" = 'PENDING';
