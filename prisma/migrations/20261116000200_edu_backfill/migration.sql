-- PR B, step 2 of 5: clear pre-launch test data that has no exact mapping, backfill tutor sets.
-- rehearse-expect-loss: tuition_requirement requirement_subject tuition_package tutor_requirement
-- Old category ids and levels 14-20 meant different things in the API and the frontend, so
-- requirements and packages are deleted rather than migrated (agreed for pre-launch only).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Applications point at requirements and packages, and disputes, fees and reports point at
-- applications. Refuse to cascade through those: clear test applications by hand first.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM application) THEN
    RAISE EXCEPTION 'edu_backfill: application rows exist. Delete test applications (and their disputes, fees, reports, notification_log rows) before deploying PR B.';
  END IF;
END $$;

-- requirement_subject rows go with their requirement (ON DELETE CASCADE).
DELETE FROM "tuition_package";
DELETE FROM "tuition_requirement";

-- Tutor sets: levels 1-13 keep their meaning, 14-20 no longer exist. The old sets had no
-- category, so they covered every curriculum.
DELETE FROM "tutor_requirement" WHERE "level_min" > 13;
UPDATE "tutor_requirement"
SET "level_max" = LEAST("level_max", 13),
    "curricula" = ARRAY['BANGLA_MEDIUM', 'ENGLISH_VERSION', 'EM_CAMBRIDGE', 'EM_EDEXCEL', 'EM_IB', 'EM_AMERICAN', 'MADRASAH']::"Curriculum"[];
