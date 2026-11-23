SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Validate the NOT VALID foreign key from 20261201000100_avatars (SHARE UPDATE EXCLUSIVE, writes keep flowing).
ALTER TABLE "account" VALIDATE CONSTRAINT "account_avatar_file_id_fkey";
