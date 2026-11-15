-- PR B, step 3 of 5: the education rules, added NOT VALID; step 4 validates them.
-- Same rules as src/lib/education.ts (education.test.ts checks the two agree).
-- Array columns stay nullable for Prisma, so each array CHECK also rejects NULL.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE "tuition_requirement"
  ADD CONSTRAINT requirement_level_range CHECK (level_code BETWEEN -4 AND 13) NOT VALID,
  ADD CONSTRAINT requirement_group_valid CHECK (
    academic_group IS NULL OR (
      level_code IS NOT NULL AND curriculum IS NOT NULL AND level_code BETWEEN 9 AND 12 AND (
        (curriculum IN ('BANGLA_MEDIUM', 'ENGLISH_VERSION') AND academic_group IN ('SCIENCE', 'BUSINESS', 'HUMANITIES'))
        OR (curriculum = 'MADRASAH' AND academic_group IN ('SCIENCE', 'HUMANITIES', 'MUJABBID'))
      )
    )
  ) NOT VALID,
  ADD CONSTRAINT requirement_targets_valid CHECK (
    admission_targets IS NOT NULL AND (cardinality(admission_targets) = 0 OR COALESCE(level_code = 13, false))
  ) NOT VALID,
  ADD CONSTRAINT requirement_retaker_valid CHECK (
    NOT is_retaker OR COALESCE(level_code IN (10, 12, 13), false)
  ) NOT VALID,
  ADD CONSTRAINT requirement_note_valid CHECK (
    level_note IS NULL OR (level_note = btrim(level_note) AND char_length(level_note) BETWEEN 1 AND 40)
  ) NOT VALID;

ALTER TABLE "tuition_package"
  ADD CONSTRAINT package_level_range CHECK (level_code BETWEEN -4 AND 13) NOT VALID,
  ADD CONSTRAINT package_group_valid CHECK (
    academic_group IS NULL OR (
      level_code IS NOT NULL AND curriculum IS NOT NULL AND level_code BETWEEN 9 AND 12 AND (
        (curriculum IN ('BANGLA_MEDIUM', 'ENGLISH_VERSION') AND academic_group IN ('SCIENCE', 'BUSINESS', 'HUMANITIES'))
        OR (curriculum = 'MADRASAH' AND academic_group IN ('SCIENCE', 'HUMANITIES', 'MUJABBID'))
      )
    )
  ) NOT VALID,
  ADD CONSTRAINT package_targets_valid CHECK (
    admission_targets IS NOT NULL AND (cardinality(admission_targets) = 0 OR COALESCE(level_code = 13, false))
  ) NOT VALID,
  ADD CONSTRAINT package_retaker_valid CHECK (
    NOT is_retaker OR COALESCE(level_code IN (10, 12, 13), false)
  ) NOT VALID,
  ADD CONSTRAINT package_note_valid CHECK (
    level_note IS NULL OR (level_note = btrim(level_note) AND char_length(level_note) BETWEEN 1 AND 40)
  ) NOT VALID;

-- Step 2 emptied tuition_package, so these scans are instant.
-- squawk-ignore adding-not-nullable-field
ALTER TABLE "tuition_package" ALTER COLUMN "level_code" SET NOT NULL;
-- squawk-ignore adding-not-nullable-field
ALTER TABLE "tuition_package" ALTER COLUMN "curriculum" SET NOT NULL;

-- Replaced by tr_level_range below (old cap was 20).
-- squawk-ignore ban-drop-constraint
ALTER TABLE "tutor_requirement" DROP CONSTRAINT tr_class_range;
ALTER TABLE "tutor_requirement"
  ADD CONSTRAINT tr_level_range CHECK (level_min >= -4 AND level_max <= 13 AND level_max >= level_min) NOT VALID,
  ADD CONSTRAINT tr_curricula_valid CHECK (curricula IS NOT NULL AND cardinality(curricula) >= 1) NOT VALID,
  -- Groups need the range to touch 9-12, and each group needs a curriculum that offers it.
  ADD CONSTRAINT tr_groups_valid CHECK (
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
  ) NOT VALID,
  ADD CONSTRAINT tr_targets_valid CHECK (
    admission_targets IS NOT NULL AND (cardinality(admission_targets) = 0 OR level_max = 13)
  ) NOT VALID;
