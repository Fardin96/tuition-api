-- The hero search suggests subjects only, so its hints name subjects instead of packages and roles.
-- Only the untouched default list is replaced; an admin's own hints stay. updated_at moves so an
-- editor opened before this deploy gets a 409 on save instead of writing the old hints back.
UPDATE "site_content"
SET "value" = jsonb_set(
      "value",
      '{skillPlaceholders}',
      '["e.g. Mathematics", "e.g. Physics", "e.g. English", "e.g. ICT"]'::jsonb
    ),
    "updated_at" = now()
WHERE "key" = 'hero'
  AND "value" -> 'skillPlaceholders'
    = '["e.g. SSC package", "e.g. Math Tutor", "e.g. English Specialist", "e.g. Physics Teacher"]'::jsonb;
