-- v6 backfill: plain UPDATEs on existing rows; old code does not read these columns.

UPDATE student SET phone_number = whatsapp_number WHERE phone_number IS NULL;
UPDATE tutor SET phone_number = whatsapp_number WHERE phone_number IS NULL;

-- Every row that exists before this release is Google Places data. PIN rows
-- only appear after this release, so the weekly expiry cron can tell them apart.
UPDATE tutor_location SET geog_source = 'PLACES';
UPDATE student_location SET geog_source = 'PLACES';
