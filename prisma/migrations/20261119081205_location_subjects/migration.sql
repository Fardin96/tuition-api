-- DropIndex
DROP INDEX "student_location_geog_gist_idx";

-- DropIndex
DROP INDEX "tutor_name_trgm";

-- DropIndex
DROP INDEX "tutor_location_geog_gist_idx";

-- DropIndex
DROP INDEX "tutor_zone_center_gix";

-- AlterTable
ALTER TABLE "student_location" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "tutor_location" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "tutor_zone" ALTER COLUMN "center" DROP NOT NULL;
