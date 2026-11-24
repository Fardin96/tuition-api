-- The landing "Get Started" button now opens sign-up with Student picked, and "Register Now" opens
-- sign-up, not sign-in.
-- updated_at moves too, so an admin editor opened before this deploy gets a 409 on save instead of
-- writing the old link back.
UPDATE "site_content"
SET "value" = jsonb_set("value", '{cta,href}', '"/sign-up?role=student"'), "updated_at" = now()
WHERE "key" = 'cta_banner' AND "value" #>> '{cta,href}' = '/sign-in';

UPDATE "site_content"
SET "value" = jsonb_set("value", '{cta,href}', '"/sign-up"'), "updated_at" = now()
WHERE "key" = 'nav' AND "value" #>> '{cta,href}' = '/sign-in';
