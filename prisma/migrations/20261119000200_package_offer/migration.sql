-- Packages become offers: a title, what they cover, a duration and a total price, plus the
-- same subjects, level range, schedule and zones as a tutor set. They no longer point at a set.
-- rehearse-expect-loss: tuition_package
-- No endpoint could create a package before this change (edu_backfill emptied the table), so
-- any rows are test data and are deleted rather than mapped.
-- Every lock and rewrite rule below is moot: the DELETE empties tuition_package and the two
-- join tables are new, so no statement scans or rewrites live rows. Types match tutor_requirement.
-- squawk-ignore-file ban-drop-column, adding-required-field, ban-drop-constraint, ban-drop-function, ban-drop-not-null, constraint-missing-not-valid, prefer-bigint-over-int, prefer-bigint-over-smallint, prefer-text-field, require-concurrent-index-deletion, require-concurrent-index-creation
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM application WHERE package_id IS NOT NULL) THEN
    RAISE EXCEPTION 'package_offer: package applications exist. Delete test package applications (and their disputes, fees, reports, notification_log rows) before deploying.';
  END IF;
END $$;

DELETE FROM "tuition_package";

-- Packages no longer belong to a set, so a set can always be archived.
DROP TRIGGER IF EXISTS package_requirement_same_tutor_trg ON "tuition_package";
DROP FUNCTION IF EXISTS package_requirement_same_tutor();
DROP TRIGGER IF EXISTS tr_block_archive_trg ON "tutor_requirement";
DROP FUNCTION IF EXISTS tr_block_archive();

CREATE TYPE "PackageCoverage" AS ENUM ('FULL_CURRICULUM', 'PARTIAL');

ALTER TABLE "tuition_package" DROP CONSTRAINT "tuition_package_area_id_fkey";
ALTER TABLE "tuition_package" DROP CONSTRAINT "tuition_package_requirement_id_fkey";
ALTER TABLE "tuition_package" DROP CONSTRAINT "tuition_package_subject_id_fkey";
DROP INDEX "tuition_package_requirement_id_idx";
DROP INDEX "tuition_package_status_moderation_status_curriculum_level_c_idx";

-- The table is empty (above), so dropping and adding NOT NULL columns rewrites nothing.
-- The old single-level checks (package_level_range, package_group_valid, ...) go with their columns.
ALTER TABLE "tuition_package" DROP COLUMN "academic_group",
DROP COLUMN "area_id",
DROP COLUMN "curriculum",
DROP COLUMN "expected_salary",
DROP COLUMN "is_retaker",
DROP COLUMN "level_code",
DROP COLUMN "level_note",
DROP COLUMN "requirement_id",
DROP COLUMN "student_count",
DROP COLUMN "subject_id",
DROP COLUMN "time_of_day",
ADD COLUMN     "academic_groups" "AcademicGroup"[] DEFAULT ARRAY[]::"AcademicGroup"[],
ADD COLUMN     "available_days" SMALLINT NOT NULL DEFAULT 127,
ADD COLUMN     "coverage" "PackageCoverage" NOT NULL,
ADD COLUMN     "curricula" "Curriculum"[],
ADD COLUMN     "description" VARCHAR(600) NOT NULL,
ADD COLUMN     "duration_weeks" SMALLINT NOT NULL,
ADD COLUMN     "level_max" SMALLINT NOT NULL,
ADD COLUMN     "level_min" SMALLINT NOT NULL,
ADD COLUMN     "max_students" SMALLINT NOT NULL DEFAULT 1,
ADD COLUMN     "price" INTEGER NOT NULL,
ADD COLUMN     "teaches_online" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "time_from" TIME(0) NOT NULL,
ADD COLUMN     "time_to" TIME(0) NOT NULL,
ADD COLUMN     "title" VARCHAR(80) NOT NULL,
ALTER COLUMN "days_per_week" DROP NOT NULL;

-- Same rules as tutor_requirement (tr_* checks) plus the offer fields. Empty table, so no NOT VALID step.
ALTER TABLE "tuition_package"
  ADD CONSTRAINT package_title_valid CHECK (title = btrim(title) AND char_length(title) >= 1),
  ADD CONSTRAINT package_description_valid CHECK (description = btrim(description) AND char_length(description) >= 1),
  ADD CONSTRAINT package_duration_valid CHECK (duration_weeks BETWEEN 1 AND 104),
  ADD CONSTRAINT package_price_positive CHECK (price > 0),
  ADD CONSTRAINT package_level_range CHECK (level_min >= -4 AND level_max <= 13 AND level_max >= level_min),
  ADD CONSTRAINT package_curricula_valid CHECK (curricula IS NOT NULL AND cardinality(curricula) >= 1),
  ADD CONSTRAINT package_groups_valid CHECK (
    academic_groups IS NOT NULL AND (
      cardinality(academic_groups) = 0 OR (
        level_min <= 12 AND level_max >= 9
        AND curricula && ARRAY['BANGLA_MEDIUM', 'ENGLISH_VERSION', 'MADRASAH']::"Curriculum"[]
        AND (NOT ('BUSINESS'::"AcademicGroup" = ANY (academic_groups))
             OR curricula && ARRAY['BANGLA_MEDIUM', 'ENGLISH_VERSION']::"Curriculum"[])
        AND (NOT ('MUJABBID'::"AcademicGroup" = ANY (academic_groups))
             OR 'MADRASAH'::"Curriculum" = ANY (curricula))
      )
    )
  ),
  ADD CONSTRAINT package_targets_valid CHECK (
    admission_targets IS NOT NULL AND (cardinality(admission_targets) = 0 OR level_max = 13)
  ),
  ADD CONSTRAINT package_time_window CHECK (time_to > time_from),
  ADD CONSTRAINT package_days_valid CHECK (available_days BETWEEN 1 AND 127),
  ADD CONSTRAINT package_days_per_week CHECK (days_per_week IS NULL OR days_per_week BETWEEN 1 AND 7),
  ADD CONSTRAINT package_students CHECK (max_students BETWEEN 1 AND 50);

-- Target of the composite FKs below.
CREATE UNIQUE INDEX "tuition_package_id_tutor_id_key" ON "tuition_package"("id", "tutor_id");

CREATE TABLE "package_subject" (
    "package_id" UUID NOT NULL,
    "tutor_id" UUID NOT NULL,
    "subject_id" INTEGER NOT NULL,

    CONSTRAINT "package_subject_pkey" PRIMARY KEY ("package_id","subject_id"),
    CONSTRAINT "package_subject_package_id_tutor_id_fkey" FOREIGN KEY ("package_id", "tutor_id") REFERENCES "tuition_package"("id", "tutor_id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "package_subject_tutor_id_subject_id_fkey" FOREIGN KEY ("tutor_id", "subject_id") REFERENCES "tutor_subject"("tutor_id", "subject_id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "package_zone" (
    "package_id" UUID NOT NULL,
    "zone_id" UUID NOT NULL,
    "tutor_id" UUID NOT NULL,

    CONSTRAINT "package_zone_pkey" PRIMARY KEY ("package_id","zone_id"),
    CONSTRAINT "package_zone_package_id_tutor_id_fkey" FOREIGN KEY ("package_id", "tutor_id") REFERENCES "tuition_package"("id", "tutor_id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "package_zone_zone_id_tutor_id_fkey" FOREIGN KEY ("zone_id", "tutor_id") REFERENCES "tutor_zone"("id", "tutor_id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Empty or new tables: plain CREATE INDEX holds the lock for no time.
CREATE INDEX "package_subject_subject_id_package_id_idx" ON "package_subject"("subject_id", "package_id");
CREATE INDEX "package_zone_zone_id_idx" ON "package_zone"("zone_id");
CREATE INDEX "tuition_package_status_moderation_status_created_at_idx" ON "tuition_package"("status", "moderation_status", "created_at" DESC);
