SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- WhatsApp is optional; phone_number stays required. Existing rows keep their values.
-- squawk-ignore ban-drop-not-null
ALTER TABLE student ALTER COLUMN whatsapp_number DROP NOT NULL;
-- squawk-ignore ban-drop-not-null
ALTER TABLE tutor ALTER COLUMN whatsapp_number DROP NOT NULL;
