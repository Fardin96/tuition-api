SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- One SSLCommerz checkout per row. Expand step: CHECKs on the new table are added with the table;
-- the fee_payment and platform_setting changes below are NOT VALID and validated in the next migration.
CREATE TYPE "PaymentAttemptStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED', 'REVIEW', 'UNAPPLIED');

CREATE TABLE "payment_attempt" (
    "id" UUID NOT NULL,
    "fee_id" UUID NOT NULL,
    "tutor_id" UUID NOT NULL,
    "tran_id" TEXT NOT NULL,
    "fee_amount" DECIMAL(12,2) NOT NULL,
    "charge_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total_amount" DECIMAL(12,2) NOT NULL,
    "status" "PaymentAttemptStatus" NOT NULL DEFAULT 'PENDING',
    "session_key" TEXT,
    "val_id" TEXT,
    "bank_tran_id" TEXT,
    "card_type" TEXT,
    -- Gateway risk flag is 0 or 1; SMALLINT matches the other small counters in the schema.
    -- squawk-ignore prefer-bigint-over-smallint
    "risk_level" SMALLINT,
    "failure_reason" TEXT,
    "gateway_response" JSONB,
    "payment_id" UUID,
    "last_checked_at" TIMESTAMPTZ(3),
    "settled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payment_attempt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payment_attempt_fee_id_fkey" FOREIGN KEY ("fee_id") REFERENCES "platform_fee"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "payment_attempt_tutor_id_fkey" FOREIGN KEY ("tutor_id") REFERENCES "tutor"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "payment_attempt_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "fee_payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "payment_attempt_tran_id_len" CHECK (char_length("tran_id") BETWEEN 1 AND 30),
    CONSTRAINT "payment_attempt_fee_positive" CHECK ("fee_amount" > 0),
    CONSTRAINT "payment_attempt_charge_nonneg" CHECK ("charge_amount" >= 0),
    CONSTRAINT "payment_attempt_total_sum" CHECK ("total_amount" = "fee_amount" + "charge_amount"),
    CONSTRAINT "payment_attempt_succeeded_has_payment" CHECK (("status" = 'SUCCEEDED') = ("payment_id" IS NOT NULL))
);

-- New, empty table: CONCURRENTLY cannot run inside the migration transaction, and nothing is locked.
-- squawk-ignore require-concurrent-index-creation
CREATE UNIQUE INDEX "payment_attempt_tran_id_key" ON "payment_attempt"("tran_id");
-- squawk-ignore require-concurrent-index-creation
CREATE UNIQUE INDEX "payment_attempt_payment_id_key" ON "payment_attempt"("payment_id");
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "payment_attempt_fee_id_created_at_idx" ON "payment_attempt"("fee_id", "created_at" DESC);
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "payment_attempt_status_created_at_idx" ON "payment_attempt"("status", "created_at");
-- At most one PENDING checkout per fee. Partial, so it cannot be expressed in schema.prisma.
-- squawk-ignore require-concurrent-index-creation
CREATE UNIQUE INDEX "payment_attempt_one_pending_per_fee" ON "payment_attempt" ("fee_id") WHERE "status" = 'PENDING';

-- Gateway payments (SSLCOMMERZ) have no admin recorder. Every existing row has one, so no data changes.
-- squawk-ignore ban-drop-not-null
ALTER TABLE "fee_payment" ALTER COLUMN "recorded_by" DROP NOT NULL;
ALTER TABLE "fee_payment" ADD CONSTRAINT "fee_payment_recorder_required" CHECK ("recorded_by" IS NOT NULL OR "method" = 'SSLCOMMERZ') NOT VALID;

-- Two new keys: online_payments_enabled (boolean) and gateway_charge_percent (0..10).
-- The new CASE is a superset of the old one, so existing rows pass; they are checked in the next migration.
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
    ELSE false
  END
) NOT VALID;
