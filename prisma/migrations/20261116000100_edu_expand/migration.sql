-- PR B (education levels), step 1 of 5: new enums and columns. Everything is nullable or
-- defaulted here; step 3 adds the CHECKs and NOT NULLs once step 2 has cleared the old data.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TYPE "Curriculum" AS ENUM ('BANGLA_MEDIUM', 'ENGLISH_VERSION', 'EM_CAMBRIDGE', 'EM_EDEXCEL', 'EM_IB', 'EM_AMERICAN', 'MADRASAH');
CREATE TYPE "AcademicGroup" AS ENUM ('SCIENCE', 'BUSINESS', 'HUMANITIES', 'MUJABBID');
CREATE TYPE "AdmissionTarget" AS ENUM ('ENGINEERING', 'MEDICAL', 'VARSITY_SCIENCE', 'VARSITY_HUMANITIES', 'VARSITY_BUSINESS', 'AGRICULTURE', 'IBA_BUP', 'PRIVATE_UNI', 'ABROAD_TESTS', 'ISSB');

ALTER TABLE "tuition_requirement"
  -- squawk-ignore prefer-bigint-over-smallint
  ADD COLUMN "level_code" SMALLINT,
  ADD COLUMN "curriculum" "Curriculum",
  ADD COLUMN "academic_group" "AcademicGroup",
  ADD COLUMN "admission_targets" "AdmissionTarget"[] DEFAULT ARRAY[]::"AdmissionTarget"[],
  ADD COLUMN "is_retaker" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "level_note" TEXT;

ALTER TABLE "tuition_package"
  -- squawk-ignore prefer-bigint-over-smallint
  ADD COLUMN "level_code" SMALLINT,
  ADD COLUMN "curriculum" "Curriculum",
  ADD COLUMN "academic_group" "AcademicGroup",
  ADD COLUMN "admission_targets" "AdmissionTarget"[] DEFAULT ARRAY[]::"AdmissionTarget"[],
  ADD COLUMN "is_retaker" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "level_note" TEXT;

-- The old 1-13 values keep their meaning on the new -4..13 scale, so tutor sets are renamed, not rebuilt.
-- squawk-ignore renaming-column
ALTER TABLE "tutor_requirement" RENAME COLUMN "class_level_min" TO "level_min";
-- squawk-ignore renaming-column
ALTER TABLE "tutor_requirement" RENAME COLUMN "class_level_max" TO "level_max";

ALTER TABLE "tutor_requirement"
  ADD COLUMN "curricula" "Curriculum"[],
  ADD COLUMN "academic_groups" "AcademicGroup"[] DEFAULT ARRAY[]::"AcademicGroup"[],
  ADD COLUMN "admission_targets" "AdmissionTarget"[] DEFAULT ARRAY[]::"AdmissionTarget"[];
