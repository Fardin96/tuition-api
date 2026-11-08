-- v6 expand: additive only, safe while old code runs

-- CreateEnum
CREATE TYPE "GeogSource" AS ENUM ('PIN', 'PLACES');

-- CreateEnum
CREATE TYPE "ZoneLimitRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'DENIED');

-- AlterEnum
ALTER TYPE "NotificationEvent" ADD VALUE 'ZONE_LIMIT_DECIDED';

-- AlterEnum
ALTER TYPE "PaymentMethod" ADD VALUE 'SSLCOMMERZ';

-- AlterTable
ALTER TABLE "application" ADD COLUMN     "match_parts" JSONB,
ADD COLUMN     "match_score" SMALLINT,
ADD COLUMN     "match_version" SMALLINT;

-- AlterTable
ALTER TABLE "student" ADD COLUMN     "phone_number" TEXT,
ADD COLUMN     "phone_verified_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "student_location" ADD COLUMN     "geog_source" "GeogSource" NOT NULL DEFAULT 'PIN',
ALTER COLUMN "place_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "tuition_package" ADD COLUMN     "requirement_id" UUID;

-- AlterTable
ALTER TABLE "tuition_requirement" ADD COLUMN     "available_days" SMALLINT NOT NULL DEFAULT 127;

-- AlterTable
ALTER TABLE "tutor" ADD COLUMN     "phone_number" TEXT,
ADD COLUMN     "phone_verified_at" TIMESTAMPTZ(3),
ADD COLUMN     "zone_limit" SMALLINT NOT NULL DEFAULT 5,
ALTER COLUMN "emergency_contact" DROP NOT NULL,
ALTER COLUMN "student_id_number" DROP NOT NULL;

-- AlterTable
ALTER TABLE "tutor_location" ADD COLUMN     "geog_source" "GeogSource" NOT NULL DEFAULT 'PIN',
ALTER COLUMN "place_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "tutor_requirement" (
    "id" UUID NOT NULL,
    "tutor_id" UUID NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "class_level_min" SMALLINT NOT NULL,
    "class_level_max" SMALLINT NOT NULL,
    "time_from" TIME(0) NOT NULL,
    "time_to" TIME(0) NOT NULL,
    "available_days" SMALLINT NOT NULL DEFAULT 127,
    "min_salary" INTEGER,
    "max_students" SMALLINT NOT NULL DEFAULT 1,
    "available_from" DATE NOT NULL,
    "teaches_online" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tutor_requirement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tutor_requirement_subject" (
    "requirement_id" UUID NOT NULL,
    "tutor_id" UUID NOT NULL,
    "subject_id" INTEGER NOT NULL,

    CONSTRAINT "tutor_requirement_subject_pkey" PRIMARY KEY ("requirement_id","subject_id")
);

-- CreateTable
CREATE TABLE "tutor_zone" (
    "id" UUID NOT NULL,
    "tutor_id" UUID NOT NULL,
    "label" VARCHAR(60) NOT NULL,
    "center" GEOGRAPHY(POINT,4326),
    "radius_m" INTEGER NOT NULL,
    "place_id" TEXT,
    "address_text" TEXT,
    "geog_source" "GeogSource" NOT NULL DEFAULT 'PIN',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tutor_zone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tutor_requirement_zone" (
    "requirement_id" UUID NOT NULL,
    "zone_id" UUID NOT NULL,
    "tutor_id" UUID NOT NULL,

    CONSTRAINT "tutor_requirement_zone_pkey" PRIMARY KEY ("requirement_id","zone_id")
);

-- CreateTable
CREATE TABLE "zone_limit_request" (
    "id" UUID NOT NULL,
    "tutor_id" UUID NOT NULL,
    "requested_limit" SMALLINT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "ZoneLimitRequestStatus" NOT NULL DEFAULT 'PENDING',
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "decision_note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "zone_limit_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "platform_setting_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "tutor_requirement_tutor_id_is_active_idx" ON "tutor_requirement"("tutor_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "tutor_requirement_id_tutor_id_key" ON "tutor_requirement"("id", "tutor_id");

-- CreateIndex
CREATE INDEX "tutor_requirement_subject_subject_id_requirement_id_idx" ON "tutor_requirement_subject"("subject_id", "requirement_id");

-- CreateIndex
CREATE INDEX "tutor_zone_tutor_id_idx" ON "tutor_zone"("tutor_id");

-- CreateIndex
CREATE UNIQUE INDEX "tutor_zone_id_tutor_id_key" ON "tutor_zone"("id", "tutor_id");

-- CreateIndex
CREATE INDEX "tutor_requirement_zone_zone_id_idx" ON "tutor_requirement_zone"("zone_id");

-- CreateIndex
CREATE INDEX "zone_limit_request_status_created_at_idx" ON "zone_limit_request"("status", "created_at");

-- CreateIndex
CREATE INDEX "zone_limit_request_tutor_id_created_at_idx" ON "zone_limit_request"("tutor_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "tuition_package_requirement_id_idx" ON "tuition_package"("requirement_id");

-- AddForeignKey
ALTER TABLE "tutor_requirement" ADD CONSTRAINT "tutor_requirement_tutor_id_fkey" FOREIGN KEY ("tutor_id") REFERENCES "tutor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tutor_requirement_subject" ADD CONSTRAINT "tutor_requirement_subject_requirement_id_tutor_id_fkey" FOREIGN KEY ("requirement_id", "tutor_id") REFERENCES "tutor_requirement"("id", "tutor_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tutor_requirement_subject" ADD CONSTRAINT "tutor_requirement_subject_tutor_id_subject_id_fkey" FOREIGN KEY ("tutor_id", "subject_id") REFERENCES "tutor_subject"("tutor_id", "subject_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tutor_zone" ADD CONSTRAINT "tutor_zone_tutor_id_fkey" FOREIGN KEY ("tutor_id") REFERENCES "tutor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tutor_requirement_zone" ADD CONSTRAINT "tutor_requirement_zone_requirement_id_tutor_id_fkey" FOREIGN KEY ("requirement_id", "tutor_id") REFERENCES "tutor_requirement"("id", "tutor_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tutor_requirement_zone" ADD CONSTRAINT "tutor_requirement_zone_zone_id_tutor_id_fkey" FOREIGN KEY ("zone_id", "tutor_id") REFERENCES "tutor_zone"("id", "tutor_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zone_limit_request" ADD CONSTRAINT "zone_limit_request_tutor_id_fkey" FOREIGN KEY ("tutor_id") REFERENCES "tutor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zone_limit_request" ADD CONSTRAINT "zone_limit_request_decided_by_fkey" FOREIGN KEY ("decided_by") REFERENCES "admin_user"("account_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tuition_package" ADD CONSTRAINT "tuition_package_requirement_id_fkey" FOREIGN KEY ("requirement_id") REFERENCES "tutor_requirement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_setting" ADD CONSTRAINT "platform_setting_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "admin_user"("account_id") ON DELETE RESTRICT ON UPDATE CASCADE;
