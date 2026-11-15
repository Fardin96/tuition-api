-- PR B, step 5 of 5: remove category and the old class level, add the curriculum/level indexes.
-- rehearse-expect-loss: category
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- The category table goes below.
-- squawk-ignore ban-drop-constraint
ALTER TABLE "tuition_requirement" DROP CONSTRAINT "tuition_requirement_category_id_fkey";
-- squawk-ignore ban-drop-constraint
ALTER TABLE "tuition_package" DROP CONSTRAINT "tuition_package_category_id_fkey";

-- Not CONCURRENTLY: the migration runs in one transaction, and both tables were emptied in step 2.
-- squawk-ignore require-concurrent-index-deletion
DROP INDEX "tuition_requirement_status_category_id_area_id_created_at_idx";
-- squawk-ignore require-concurrent-index-deletion
DROP INDEX "tuition_package_status_moderation_status_category_id_subjec_idx";

-- Dropping class_level also drops requirement_class_level_range and package_class_level_range.
-- Pre-launch: no deployed code reads these columns after PR B.
-- squawk-ignore ban-drop-column
ALTER TABLE "tuition_requirement" DROP COLUMN "category_id", DROP COLUMN "class_level";
-- squawk-ignore ban-drop-column
ALTER TABLE "tuition_package" DROP COLUMN "category_id", DROP COLUMN "class_level";

-- Curriculum replaces category; endpoints #17, #19 and #20 are gone.
-- squawk-ignore ban-drop-table
DROP TABLE "category";

-- Plain (not CONCURRENTLY): the migration runs as one script and both tables were emptied in step 2.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "tuition_requirement_status_curriculum_level_code_area_id_cr_idx" ON "tuition_requirement" ("status", "curriculum", "level_code", "area_id", "created_at" DESC);
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "tuition_package_status_moderation_status_curriculum_level_c_idx" ON "tuition_package" ("status", "moderation_status", "curriculum", "level_code", "subject_id", "area_id", "created_at" DESC);
