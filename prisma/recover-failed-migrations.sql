-- Runs before `prisma migrate deploy` (see `scripts/migrate.sh` and `.do/app.yaml`).
-- Recovers from any failed `*_location_postgis` migration attempt in production:
-- the original migration folder no longer exists (replaced by 20261022876543_location_postgis),
-- but its failed row in _prisma_migrations blocks every deploy with P3009.
-- No-op on fresh databases and once the row is resolved.
-- shortcut: scoped to location_postgis migrations, delete this file and its step in
-- scripts/migrate.sh once production has deployed successfully.
DO $$
BEGIN
  IF to_regclass('public._prisma_migrations') IS NULL THEN
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM _prisma_migrations
    WHERE migration_name LIKE '%\_location\_postgis'
      AND finished_at IS NULL
      AND rolled_back_at IS NULL
  ) THEN
    RETURN;
  END IF;

  -- Revert any partial work so the replacement migration can create everything cleanly.
  -- These tables never deployed successfully, so they hold no user data.
  DROP TABLE IF EXISTS tutor_location CASCADE;
  DROP TABLE IF EXISTS student_location CASCADE;

  -- Same effect as `prisma migrate resolve --rolled-back 20261022160000_location_postgis`.
  UPDATE _prisma_migrations
  SET rolled_back_at = now()
  WHERE migration_name LIKE '%\_location\_postgis'
    AND finished_at IS NULL
    AND rolled_back_at IS NULL;
END $$;
