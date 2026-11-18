SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Promo codes on tutor fees. Both tables are new, so their CHECKs are added with the table.
CREATE TYPE "PromoDiscountType" AS ENUM ('PERCENT', 'FLAT');
CREATE TYPE "PromoRedemptionStatus" AS ENUM ('ACTIVE', 'RELEASED');

CREATE TABLE "promo_code" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "discount_type" "PromoDiscountType" NOT NULL,
    "discount_value" DECIMAL(12,2) NOT NULL,
    "max_discount" DECIMAL(12,2),
    "starts_at" TIMESTAMPTZ(3),
    "ends_at" TIMESTAMPTZ(3),
    -- Redemption limits are small counts, like the other INTEGER limits in the schema.
    -- squawk-ignore prefer-bigint-over-int
    "max_redemptions" INTEGER,
    -- squawk-ignore prefer-bigint-over-int
    "max_per_tutor" INTEGER NOT NULL DEFAULT 1,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "promo_code_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "promo_code_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "admin_user"("account_id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "promo_code_format" CHECK ("code" ~ '^[A-Z0-9][A-Z0-9_-]{2,31}$'),
    CONSTRAINT "promo_code_discount_valid" CHECK (
      ("discount_type" = 'PERCENT' AND "discount_value" > 0 AND "discount_value" <= 100)
      OR ("discount_type" = 'FLAT' AND "discount_value" > 0)
    ),
    CONSTRAINT "promo_code_max_discount_positive" CHECK ("max_discount" IS NULL OR "max_discount" > 0),
    CONSTRAINT "promo_code_window" CHECK ("starts_at" IS NULL OR "ends_at" IS NULL OR "ends_at" > "starts_at"),
    CONSTRAINT "promo_code_limits" CHECK (("max_redemptions" IS NULL OR "max_redemptions" >= 1) AND "max_per_tutor" >= 1)
);

CREATE TABLE "promo_redemption" (
    "id" UUID NOT NULL,
    "promo_id" UUID NOT NULL,
    "fee_id" UUID NOT NULL,
    "tutor_id" UUID NOT NULL,
    "original_amount" DECIMAL(12,2) NOT NULL,
    "discount_amount" DECIMAL(12,2) NOT NULL,
    "status" "PromoRedemptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "released_at" TIMESTAMPTZ(3),
    "release_reason" TEXT,

    CONSTRAINT "promo_redemption_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "promo_redemption_promo_id_fkey" FOREIGN KEY ("promo_id") REFERENCES "promo_code"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "promo_redemption_fee_id_fkey" FOREIGN KEY ("fee_id") REFERENCES "platform_fee"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "promo_redemption_tutor_id_fkey" FOREIGN KEY ("tutor_id") REFERENCES "tutor"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "promo_redemption_amounts" CHECK ("original_amount" > 0 AND "discount_amount" > 0 AND "discount_amount" <= "original_amount"),
    CONSTRAINT "promo_redemption_released_shape" CHECK (("status" = 'RELEASED') = ("released_at" IS NOT NULL))
);

-- New, empty tables: CONCURRENTLY cannot run inside the migration transaction, and nothing is locked.
-- squawk-ignore require-concurrent-index-creation
CREATE UNIQUE INDEX "promo_code_code_key" ON "promo_code"("code");
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "promo_code_is_active_created_at_idx" ON "promo_code"("is_active", "created_at" DESC);
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "promo_redemption_promo_id_status_idx" ON "promo_redemption"("promo_id", "status");
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "promo_redemption_tutor_id_promo_id_idx" ON "promo_redemption"("tutor_id", "promo_id");
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "promo_redemption_fee_id_idx" ON "promo_redemption"("fee_id");
-- One code per fee: at most one ACTIVE redemption. Partial, so it cannot be expressed in schema.prisma.
-- squawk-ignore require-concurrent-index-creation
CREATE UNIQUE INDEX "promo_redemption_one_active_per_fee" ON "promo_redemption" ("fee_id") WHERE "status" = 'ACTIVE';

-- A voided fee gives its code back: the ACTIVE redemption is released in the same transaction.
CREATE OR REPLACE FUNCTION promo_release_on_fee_void() RETURNS trigger AS $$
BEGIN
  UPDATE promo_redemption
     SET status = 'RELEASED', released_at = now(), release_reason = 'Fee voided'
   WHERE fee_id = NEW.id AND status = 'ACTIVE';
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER promo_release_on_fee_void_trg AFTER UPDATE OF status ON platform_fee
  FOR EACH ROW WHEN (NEW.status = 'VOID' AND OLD.status IS DISTINCT FROM 'VOID')
  EXECUTE FUNCTION promo_release_on_fee_void();
