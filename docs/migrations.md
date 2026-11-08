# Migrations Reference

Quick reference for running and recovering Prisma migrations in this repo.

---

## 1. How migrations run

| Trigger              | What happens                                                                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Push to`main`        | DO App Platform starts a build. The`migrate` **PRE_DEPLOY** job runs `bash scripts/migrate.sh`.                                                                                                         |
| `scripts/migrate.sh` | Runs`prisma/recover-failed-migrations.sql` (fixes any stuck `location_postgis` row), then `npx prisma migrate deploy` against the **direct URL (port 25060)**. The pooler is never used for migrations. |
| Failed migration     | The PRE_DEPLOY job fails, the deploy is aborted, and the**old service keeps running**.                                                                                                                  |

**Important:**

- `prisma migrate dev` is **only for creating migrations**. Never use it on a DB with data. Never run `prisma migrate reset` in shared/dev environments (it destroys data).
- `DATABASE_URL` in the repo is the direct URL (port 25060). There is no `DATABASE_DIRECT_URL`.

---

## 2. Migration history

| Folder                                      | Name                       | One-line purpose                                                                                                                                                                       |
| ------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `20261020122427_init`                       | init                       | Baseline schema (28 tables).                                                                                                                                                           |
| `20261022876543_location_postgis`           | location_postgis           | Enables PostGIS and creates`tutor_location` / `student_location` with `GEOGRAPHY(POINT,4326)` and GIST indexes.                                                                        |
| `20261026000000_draft_requirements`         | draft_requirements         | Makes`tuition_requirement` fields nullable so requirements can be saved as drafts.                                                                                                     |
| `20261027000000_multi_subject_requirements` | multi_subject_requirements | Adds`requirement_subject` (many subjects per requirement) and drops `tuition_requirement.subject_id`.                                                                                  |
| `20261107000100_v6_expand`                  | v6_expand                  | Additive schema: new enums, tables (tutor_requirement, tutor_zone, zone_limit_request, platform_setting), nullable columns, defaults.                                                  |
| `20261107000200_v6_backfill`                | v6_backfill                | Backfills`phone_number = whatsapp_number` and `geog_source = 'PLACES'` on existing rows.                                                                                               |
| `20261107000300_v6_constraints`             | v6_constraints             | Adds CHECKs (NOT VALID), indexes, triggers, functions (`recompute_is_listed`, `tutor_missing_requirements`), seeds, phone NOT NULL + unique indexes, transitional phone-fill triggers. |
| `20261107000400_v6_validate`                | v6_validate                | Runs`VALIDATE CONSTRAINT` on all NOT VALID constraints. `fee_payment_method_allowed` stays NOT VALID if violating rows exist.                                                          |
| `20261107000500_v6_contact_unique`          | v6_contact_unique          | Global phone/WhatsApp uniqueness across student+tutor via trigger`contact_number_guard` with pre-flight hard fail on existing duplicates.                                              |

**Note:** v6 ran cleanly on a restored copy of the production backup before being pushed.

---

## 3. Safe migration procedure

1. **Dump production** with `pg_dump` (custom format, `--no-acl --no-owner`) after adding your IP to DO Trusted Sources. Use the direct URL (port 25060) with `sslrootcert=ca-certificate.crt&sslmode=verify-full`.

   ```bash
   pg_dump "$DATABASE_URL" --format=custom --no-acl --no-owner -f ".backups/backup-$(date +%F).dump"

   # Alternative (Homebrew libpq on macOS):
   /opt/homebrew/Cellar/libpq/18.6_1/bin/pg_dump "$DATABASE_URL" --format=custom --no-acl --no-owner -f ".backups/backup-$(date +%F).dump"
   ```

2. **Restore into a scratch local DB** with PostGIS:
   ```bash
   createdb scratch
   psql scratch -c 'CREATE EXTENSION postgis'
   pg_restore --no-owner --no-acl -d scratch <dump-file>
   ```
3. **Run pre-flight** against the copy:
   ```bash
   bash .misc/v6-preflight.sh "<local-url>"
   ```
4. **Run migrations** on the copy:
   ```bash
   DATABASE_URL=<local-url> npx prisma migrate deploy
   ```
5. **Verify**:
   ```bash
   npx prisma migrate status
   ```
6. **Run the full CI suite** locally:
   ```bash
   yarn lint && yarn typecheck && yarn test:ci && yarn build
   ```
7. **Run pre-flight against production** (read-only).
8. **Push to main.** The PRE_DEPLOY job will run the same migrations.

### Pre-flight script

Before a risky migration, run a read-only pre-flight against the target DB (scratch copy first, then production). Pass the **direct URL as an argument** so a shell-exported `DATABASE_URL` cannot pick the wrong target.

`.misc/v6-preflight.sh` is the v6 example. For a future migration, write a similar script that fails on that migration's risky data and fix FAIL rows before deploying. Include checks such as:

- values that would violate a new CHECK or unique constraint (e.g. duplicate contact numbers across tables)
- rows outside an allowed domain (e.g. enum/method allow-lists, lat/lng bounds)
- format violations the migration will enforce (e.g. phone/`E.164`-style patterns)
- baseline counts you care about after deploy (e.g. listed tutors) so you can spot unexpected drops

### Rehearsing on old migrations only

Restore the **pre-change dump** so `_prisma_migrations` already holds the old migrations. Never put folders inside `prisma/migrations`, since Prisma counts any folder there as a migration. Move folders to `/tmp` if needed.

---

## 4. Important commands

| Command                                                                                                                                 | Purpose                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pg_dump "$DATABASE_URL" --format=custom --no-acl --no-owner -f .backups/backup-$(date +%F).dump`                                       | Full backup (direct URL, port 25060). Wrap URL in single quotes in zsh because of`?`.                                                                                                                                                                                                             |
| `/opt/homebrew/Cellar/libpq/18.6_1/bin/pg_dump "$DATABASE_URL" --format=custom --no-acl --no-owner -f .backups/backup-$(date +%F).dump` | Same, explicit Homebrew libpq path on macOS.                                                                                                                                                                                                                                                      |
| `pg_restore --no-owner --no-acl -d <dbname> <dump-file>`                                                                                | Restore custom-format dump into a local DB (PostGIS must exist first).                                                                                                                                                                                                                            |
| `npx prisma migrate status`                                                                                                             | Show applied/pending migrations against the target DB.                                                                                                                                                                                                                                            |
| `npx prisma migrate deploy`                                                                                                             | Apply all pending migrations (production command).                                                                                                                                                                                                                                                |
| `npx prisma migrate resolve --rolled-back <migration-name>`                                                                             | Mark a failed migration as rolled back so deploy can continue.                                                                                                                                                                                                                                    |
| `npx prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma`                                          | Diff applied migrations vs current schema. Prisma 7: no`--shadow-database-url` flag. **Expected leftovers:** `geog` / `tutor.name` / `tutor_zone.center` indexes, `gen_random_uuid()` / `now()` defaults on location tables. Never accept `DROP INDEX` for the protected indexes (see AGENTS.md). |
| `psql "$URL" -Atc "select current_database()"`                                                                                          | Confirm which database you are connected to.                                                                                                                                                                                                                                                      |
| `psql "$URL" -c "select migration_name, logs from _prisma_migrations where finished_at is null and rolled_back_at is null"`             | View the full error of a failed migration.                                                                                                                                                                                                                                                        |

**Quoting rule:** In zsh, always wrap connection strings in **single quotes** because they contain `?` and `&`.

---

## 5. Failures hit and fixes

### Migration 05 aborts with `P0001`; later runs block with `P3009`
**Cause:** Cross-account duplicate phone/WhatsApp number found by pre-flight (e).
**Fix:** Fix the duplicate data manually, then:
```bash
npx prisma migrate resolve --rolled-back 20261107000500_v6_contact_unique
npx prisma migrate deploy
```

### `migrate dev` only shows a reset prompt
**Cause:** A migration failed; `migrate dev` treats it as drift.
**Fix:** Use `migrate deploy` on any DB with data — it prints the real DB error. Never reset a DB that has data.

### Migrations ran against the wrong DB; app errors `P2022 column does not exist`
**Cause:** `set -a; source .env` exported `DATABASE_URL` into the shell; `--env-file` does not override existing vars.
**Fix:** Unset before commands, never `source .env` in the dev terminal, and always pass explicit URLs:
```bash
unset DATABASE_URL DATABASE_POOL_URL TEST_DATABASE_URL
# one-off psql without polluting the shell:
(set -a; source .env; psql "$DATABASE_URL" ...)
```

### Server keeps using the old DB after an `.env` edit
**Cause:** `tsx watch` does not restart on `.env` changes; `DATABASE_POOL_URL` takes precedence over `DATABASE_URL`.
**Fix:** Unset shell vars, change both `DATABASE_URL` and `DATABASE_POOL_URL` together, then restart `yarn dev`.

### `psql "$DATABASE_URL"` → `database "<user>" does not exist`
**Cause:** Variable is empty; psql falls back to the OS user as the DB name.
**Fix:** Pass the URL explicitly; never rely on an unset variable.

### `lock_timeout` / `statement_timeout` during deploy
**Cause:** Brief lock contention on `ADD CONSTRAINT`, `CREATE TRIGGER`, or `VALIDATE`.
**Fix:** Retry the deploy. Migrations 03 and 04 set `SET LOCAL statement_timeout = '60s'` and `lock_timeout = '5s'`.

### Failed migration rolls back but earlier ones stay applied
**Cause:** Prisma rolls back only the failed file.
**Fix:** Earlier migrations remain. Fix the failed file (rolled-back migrations may be edited), then:
```bash
npx prisma migrate resolve --rolled-back <migration-name>
npx prisma migrate deploy
```
Never edit a migration that finished.

---

## 6. Rules

- **Never edit a migration that finished.** Only unapplied or rolled-back migrations may be changed.
- **No down migrations.** Forward-fix with SQL. Last resort: restore the dump into a **NEW cluster** and repoint the app.
- **Every change to `prisma/constraints.sql` needs its own migration** carrying the same SQL.
- **Never accept `DROP INDEX`** for the protected indexes: `tutor_name_trgm`, `notification_due_idx`, `tutor_location_geog_gist_idx`, `student_location_geog_gist_idx`, `tutor_zone_center_gix`, `tutor_requirement_one_default`, `zlr_one_pending_per_tutor`, `fee_payment_gateway_ref_uniq`.
- **`CREATE INDEX CONCURRENTLY` goes in its own non-transactional migration file.** It cannot run inside the transaction used by other migrations.
