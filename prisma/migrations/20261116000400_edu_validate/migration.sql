-- PR B, step 4 of 5: validate the step 3 CHECKs (SHARE UPDATE EXCLUSIVE, writes keep flowing).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE "tuition_requirement" VALIDATE CONSTRAINT requirement_level_range;
ALTER TABLE "tuition_requirement" VALIDATE CONSTRAINT requirement_group_valid;
ALTER TABLE "tuition_requirement" VALIDATE CONSTRAINT requirement_targets_valid;
ALTER TABLE "tuition_requirement" VALIDATE CONSTRAINT requirement_retaker_valid;
ALTER TABLE "tuition_requirement" VALIDATE CONSTRAINT requirement_note_valid;

ALTER TABLE "tuition_package" VALIDATE CONSTRAINT package_level_range;
ALTER TABLE "tuition_package" VALIDATE CONSTRAINT package_group_valid;
ALTER TABLE "tuition_package" VALIDATE CONSTRAINT package_targets_valid;
ALTER TABLE "tuition_package" VALIDATE CONSTRAINT package_retaker_valid;
ALTER TABLE "tuition_package" VALIDATE CONSTRAINT package_note_valid;

ALTER TABLE "tutor_requirement" VALIDATE CONSTRAINT tr_level_range;
ALTER TABLE "tutor_requirement" VALIDATE CONSTRAINT tr_curricula_valid;
ALTER TABLE "tutor_requirement" VALIDATE CONSTRAINT tr_groups_valid;
ALTER TABLE "tutor_requirement" VALIDATE CONSTRAINT tr_targets_valid;
