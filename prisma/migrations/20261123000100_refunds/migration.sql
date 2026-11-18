SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Refunds of SSLCommerz payments. Expand step: CHECKs on the new table are added with the table;
-- the platform_setting CHECK is replaced NOT VALID and validated in the next migration.
CREATE TYPE "RefundStatus" AS ENUM ('REQUESTED', 'REJECTED', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'NEEDS_REVIEW');
CREATE TYPE "RefundSource" AS ENUM ('TUTOR', 'ADMIN');

CREATE TABLE "payment_refund" (
    "id" UUID NOT NULL,
    "attempt_id" UUID NOT NULL,
    "fee_id" UUID NOT NULL,
    "tutor_id" UUID NOT NULL,
    "payment_id" UUID,
    "amount" DECIMAL(12,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "source" "RefundSource" NOT NULL,
    "status" "RefundStatus" NOT NULL DEFAULT 'REQUESTED',
    "requested_by" UUID NOT NULL,
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "decision_note" TEXT,
    "refund_ref_id" TEXT,
    "failure_reason" TEXT,
    "gateway_response" JSONB,
    "reversal_id" UUID,
    "last_checked_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payment_refund_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payment_refund_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "payment_attempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "payment_refund_fee_id_fkey" FOREIGN KEY ("fee_id") REFERENCES "platform_fee"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "payment_refund_tutor_id_fkey" FOREIGN KEY ("tutor_id") REFERENCES "tutor"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "payment_refund_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "fee_payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "payment_refund_reversal_id_fkey" FOREIGN KEY ("reversal_id") REFERENCES "fee_payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "payment_refund_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "account"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "payment_refund_decided_by_fkey" FOREIGN KEY ("decided_by") REFERENCES "admin_user"("account_id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "payment_refund_amount_positive" CHECK ("amount" > 0),
    CONSTRAINT "payment_refund_reason_len" CHECK (char_length(btrim("reason")) BETWEEN 3 AND 500),
    -- Every state past REQUESTED was decided by an admin (an admin-started refund is decided at once).
    CONSTRAINT "payment_refund_decided_shape" CHECK ("status" = 'REQUESTED' OR ("decided_by" IS NOT NULL AND "decided_at" IS NOT NULL)),
    CONSTRAINT "payment_refund_completed_shape" CHECK (("status" IN ('SUCCEEDED', 'FAILED', 'REJECTED')) = ("completed_at" IS NOT NULL)),
    CONSTRAINT "payment_refund_reversal_only_succeeded" CHECK ("reversal_id" IS NULL OR "status" = 'SUCCEEDED')
);

-- New, empty table: CONCURRENTLY cannot run inside the migration transaction, and nothing is locked.
-- squawk-ignore require-concurrent-index-creation
CREATE UNIQUE INDEX "payment_refund_reversal_id_key" ON "payment_refund"("reversal_id");
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "payment_refund_status_created_at_idx" ON "payment_refund"("status", "created_at");
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "payment_refund_fee_id_created_at_idx" ON "payment_refund"("fee_id", "created_at" DESC);
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "payment_refund_attempt_id_idx" ON "payment_refund"("attempt_id");
-- At most one open refund per attempt. Partial, so it cannot be expressed in schema.prisma.
-- squawk-ignore require-concurrent-index-creation
CREATE UNIQUE INDEX "payment_refund_one_open_per_attempt" ON "payment_refund" ("attempt_id")
  WHERE "status" IN ('REQUESTED', 'PROCESSING', 'NEEDS_REVIEW');
-- The gateway's refund reference is recorded once.
-- squawk-ignore require-concurrent-index-creation
CREATE UNIQUE INDEX "payment_refund_ref_uniq" ON "payment_refund" ("refund_ref_id") WHERE "refund_ref_id" IS NOT NULL;

-- New key refund_window_days: a whole number of days, 0..90. The new CASE is a superset of the
-- old one, so existing rows pass; they are checked in the next migration.
-- squawk-ignore ban-drop-constraint
ALTER TABLE "platform_setting" DROP CONSTRAINT "platform_setting_value_valid";
ALTER TABLE "platform_setting" ADD CONSTRAINT "platform_setting_value_valid" CHECK (
  CASE key
    WHEN 'require_tutor_verification' THEN jsonb_typeof(value) = 'boolean'
    WHEN 'require_phone_verification' THEN jsonb_typeof(value) = 'boolean'
    WHEN 'online_payments_enabled' THEN jsonb_typeof(value) = 'boolean'
    WHEN 'commission_percent' THEN
      CASE WHEN jsonb_typeof(value) = 'number' THEN (value #>> '{}')::numeric BETWEEN 0 AND 100 ELSE false END
    WHEN 'gateway_charge_percent' THEN
      CASE WHEN jsonb_typeof(value) = 'number' THEN (value #>> '{}')::numeric BETWEEN 0 AND 10 ELSE false END
    WHEN 'refund_window_days' THEN
      CASE WHEN jsonb_typeof(value) = 'number'
        THEN (value #>> '{}')::numeric BETWEEN 0 AND 90 AND (value #>> '{}')::numeric = trunc((value #>> '{}')::numeric)
        ELSE false END
    ELSE false
  END
) NOT VALID;
