SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Super admins invite a new admin by email. An open invite makes the invited Google account an ACTIVE
-- admin on its next sign-in. Accepting or revoking deletes the row; audit_log keeps the history.

CREATE TABLE "admin_invite" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "invited_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "admin_invite_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "admin_invite_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "admin_user"("account_id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "admin_invite_email_lower" CHECK ("email" = lower("email"))
);

-- Plain (not CONCURRENTLY): the migration runs as one script, and the table is new and empty.
-- squawk-ignore require-concurrent-index-creation
CREATE UNIQUE INDEX "admin_invite_email_key" ON "admin_invite"("email");
