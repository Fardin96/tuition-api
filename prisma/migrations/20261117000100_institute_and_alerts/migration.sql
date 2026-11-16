SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Tutor's university or college. Nullable: existing tutors have none yet.
ALTER TABLE "tutor" ADD COLUMN "institute_name" TEXT;

-- In-app alerts for the dashboard bell.
CREATE TYPE "AppNotificationKind" AS ENUM (
    'APPLICATION_RECEIVED',
    'PACKAGE_REQUESTED',
    'APPLICATION_ACCEPTED',
    'APPLICATION_DECLINED',
    'LISTING_FILLED',
    'APPLICATION_WITHDRAWN',
    'APPLICATION_REOPENED',
    'APPLICATION_CANCELLED',
    'APPLICATION_COMPLETED'
);

CREATE TABLE "app_notification" (
    "id" UUID NOT NULL,
    "recipient_account_id" UUID NOT NULL,
    "kind" "AppNotificationKind" NOT NULL,
    "application_id" UUID NOT NULL,
    "read_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_notification_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "app_notification_recipient_account_id_fkey" FOREIGN KEY ("recipient_account_id") REFERENCES "account"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "app_notification_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "application"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- New, empty table: nothing to block, and CONCURRENTLY cannot run inside the migration transaction.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "app_notification_recipient_account_id_created_at_idx" ON "app_notification"("recipient_account_id", "created_at" DESC);
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "app_notification_application_id_idx" ON "app_notification"("application_id");
