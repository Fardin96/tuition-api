SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Any active admin (not only a super admin) may block and unblock a student or tutor. An admin
-- account only a super admin may block or unblock, and a super admin still cannot be blocked.
-- Only the function body changes; the trigger keeps pointing at it.
CREATE OR REPLACE FUNCTION account_block_guard() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin_user s WHERE s.account_id = NEW.blocked_by AND s.status = 'ACTIVE') THEN
    RAISE EXCEPTION 'only an active admin can block';
  END IF;
  IF NEW.unblocked_by IS NOT NULL AND NOT EXISTS (SELECT 1 FROM admin_user s WHERE s.account_id = NEW.unblocked_by AND s.status = 'ACTIVE') THEN
    RAISE EXCEPTION 'only an active admin can unblock';
  END IF;
  IF EXISTS (SELECT 1 FROM admin_user u WHERE u.account_id = NEW.account_id AND u.admin_role = 'SUPER_ADMIN') THEN
    RAISE EXCEPTION 'a super admin cannot be blocked';
  END IF;
  IF EXISTS (SELECT 1 FROM admin_user u WHERE u.account_id = NEW.account_id) THEN
    -- Checked when the block is made, so it can still be lifted after its author leaves.
    IF TG_OP = 'INSERT' AND NOT EXISTS (SELECT 1 FROM admin_user s WHERE s.account_id = NEW.blocked_by AND s.admin_role = 'SUPER_ADMIN' AND s.status = 'ACTIVE') THEN
      RAISE EXCEPTION 'only an active super admin can block an admin';
    END IF;
    IF NEW.unblocked_by IS NOT NULL AND NOT EXISTS (SELECT 1 FROM admin_user s WHERE s.account_id = NEW.unblocked_by AND s.admin_role = 'SUPER_ADMIN' AND s.status = 'ACTIVE') THEN
      RAISE EXCEPTION 'only an active super admin can unblock an admin';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
