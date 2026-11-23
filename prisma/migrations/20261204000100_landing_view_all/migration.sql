-- The landing "View All" under Emerging Masters now opens the emerging tutors list, and the FAQ has no link.
-- updated_at moves too, so an admin editor opened before this deploy gets a 409 on save instead of
-- writing the old link back.
UPDATE "site_content"
SET "value" = jsonb_set("value", '{cta,href}', '"/tutors?sort=emerging"'), "updated_at" = now()
WHERE "key" = 'categories' AND "value" #>> '{cta,href}' = '/sign-in';

UPDATE "site_content"
SET "value" = "value" - 'cta', "updated_at" = now()
WHERE "key" = 'faq' AND "value" ? 'cta';
