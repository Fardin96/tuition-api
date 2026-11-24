SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Validate the NOT VALID foreign keys from 20261205000100_institutions (SHARE UPDATE EXCLUSIVE), then link
-- existing free text here, outside the migration that took ACCESS EXCLUSIVE locks to add the columns.
ALTER TABLE "tutor" VALIDATE CONSTRAINT "tutor_institution_id_fkey";
ALTER TABLE "tuition_requirement" VALIDATE CONSTRAINT "tuition_requirement_institution_id_fkey";

-- Link existing free text that names exactly one default institution. The text itself is kept.
UPDATE "tutor" t SET "institution_id" = m.id
FROM (
  SELECT t2.id AS tutor_id, min(i.id) AS id
  FROM "tutor" t2 JOIN "institution" i ON i.name_key = institution_norm(t2.institute_name)
  WHERE t2.institute_name IS NOT NULL
  GROUP BY t2.id HAVING count(*) = 1
) m
WHERE t.id = m.tutor_id;

UPDATE "tuition_requirement" r SET "institution_id" = m.id
FROM (
  SELECT r2.id AS requirement_id, min(i.id) AS id
  FROM "tuition_requirement" r2 JOIN "institution" i ON i.name_key = institution_norm(r2.institute_name)
  WHERE r2.institute_name IS NOT NULL
  GROUP BY r2.id HAVING count(*) = 1
) m
WHERE r.id = m.requirement_id;
