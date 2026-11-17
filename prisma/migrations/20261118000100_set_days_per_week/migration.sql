SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- How many days a week a tutor set teaches. Nullable: existing sets keep "any".
-- SMALLINT matches the other tutor_requirement day/count columns; the CHECK below caps it at 1..7.
-- squawk-ignore prefer-bigint-over-smallint
ALTER TABLE "tutor_requirement" ADD COLUMN "days_per_week" SMALLINT;

-- Every existing row is NULL, so validation is instant.
ALTER TABLE "tutor_requirement" ADD CONSTRAINT "tr_days_per_week_range" CHECK ("days_per_week" BETWEEN 1 AND 7) NOT VALID;
ALTER TABLE "tutor_requirement" VALIDATE CONSTRAINT "tr_days_per_week_range";
