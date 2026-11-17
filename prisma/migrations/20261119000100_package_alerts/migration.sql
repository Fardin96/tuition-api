SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- In-app alerts to students when a tutor edits or closes a package they requested.
-- The new values are not used in this transaction, so ADD VALUE is safe here.
ALTER TYPE "AppNotificationKind" ADD VALUE 'PACKAGE_UPDATED' AFTER 'APPLICATION_COMPLETED';
ALTER TYPE "AppNotificationKind" ADD VALUE 'PACKAGE_CLOSED' AFTER 'PACKAGE_UPDATED';
