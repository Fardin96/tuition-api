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

### Automated: `scripts/migrate-safe.sh`

Does steps 1 to 5 of the manual procedure below in one command, plus checks on the migration files. Prod is only read.

```bash
bash scripts/migrate-safe.sh '<prod direct url>'          # full rehearsal
bash scripts/migrate-safe.sh --drill '<prod direct url>'  # restore drill
bash scripts/migrate-safe.sh --keep '<prod direct url>'   # keep the scratch DB for inspection (any position)
```

Use the direct URL (port 25060) and add your IP to DO Trusted Sources first. Wrap the URL in single quotes (zsh).

If the `pg_dump` on your `PATH` is older than the server, the script looks in the Homebrew dirs (`/opt/homebrew/opt/libpq/bin`, `postgresql@<N>/bin`) and uses `pg_dump` and `pg_restore` from there. If none is new enough, run `brew install libpq`.

| Flag | What it does |
| --- | --- |
| (none) | Dumps prod, restores into a local scratch DB, applies the pending migrations there, checks `migrate status` and row counts, prints `SAFE TO PUSH` and writes `.backups/.rehearsed`. |
| `--drill` | Dumps prod, restores it and compares row counts with prod. Applies no migrations, so it works with nothing pending. Proves your backups restore. |
| `--keep` | Does not drop the scratch DB on success. On failure the DB is always kept. |

| What it catches | Step |
| --- | --- |
| Wrong DB or pooler URL, IP not trusted, `pg_dump` older than the server | 0 |
| Stuck failed migration (P3009) | 1, 8 |
| Applied migration edited after apply | 1 |
| Applied on prod but missing locally (warning only, as with the renamed `location_postgis`) | 1 |
| Protected `DROP INDEX` not recreated in the same file | 2 |
| Risky SQL: data loss, table rewrites, locks (warnings, asks `y/N`) | 2 |
| Backup that does not restore | 4, 5 |
| Data that makes a migration abort (the rehearsal runs on a fresh prod copy) | 6 |
| Slow migration (over 60s) | 6 |
| Rows lost after migrate | 7 |

**When it runs**

- By hand, before pushing a migration.
- The pre-push hook blocks pushes that touch `prisma/migrations` unless `.backups/.rehearsed` matches the current migration files.
- Monthly `--drill`. DO keeps 7 daily backups, but only a restored dump proves a backup works.

**`git push --no-verify`** skips ALL pre-push checks (the rehearsal gate, lint, typecheck, tests, build). Use it only when the hook is wrong or you cannot run it, for example a docs-only push with no `DATABASE_URL`, or an emergency fix. Never use it to push an unrehearsed migration.

**`.rehearsed` stamp.** It is a hash of every `migration.sql`. Any edit, add or delete changes the hash, so you must rehearse again.

Optional monthly drill via cron. One-time setup:

```bash
security add-generic-password -s tuition-prod-db -a doadmin -w '<prod direct url>'
```

`crontab -e`:

```
0 9 1 * * PATH=/opt/homebrew/opt/libpq/bin:/opt/homebrew/bin:$PATH; cd /Volumes/HomeX/projects/products/tuition-api && bash scripts/migrate-safe.sh --drill "$(security find-generic-password -s tuition-prod-db -w)" >> .backups/drill.log 2>&1
```

Cron needs your laptop IP in DO Trusted Sources.

### Squawk (CI)

[Squawk](https://squawkhq.com) is a Postgres migration linter. It runs in CI via `yarn lint:sql` on every push and PR, so it also catches pushes that used `--no-verify`. Install: `yarn add -D squawk-cli` (already done). Run locally with `yarn lint:sql`. It checks only migrations added after the existing history (listed in `excluded_paths` in `.squawk.toml`). Each new migration is linted with all rules. To silence a deliberate warning, add `-- squawk-ignore <rule>` above the statement, or add the rule to `excluded_rules` in `.squawk.toml` with a reason. Squawk complements the protected-index check in `migrate-safe.sh`; it does not replace it.

- `prefer-robust-stmts` is excluded globally in `.squawk.toml` because Prisma handles failed migrations; every other rule stays on.
- Squawk checks lock and downtime risk, not query speed; use `EXPLAIN ANALYZE` for query performance.
- Only migrations added after the 9 listed in `excluded_paths` are linted. Do not add new migrations to that list.
- For a deliberate warning, put `-- squawk-ignore <rule>` on the line above the statement with a short reason, instead of adding the rule to `excluded_rules`.

### Testing the script

Never test against production. Build a fake prod from the Nov 7 backup (pre-v6, so all five v6 migrations are pending).

```bash
P='postgresql://user:password@localhost:5432'
createdb tuition_fakeprod
psql "$P/tuition_fakeprod" -c 'CREATE EXTENSION IF NOT EXISTS postgis'
pg_restore --no-acl --no-owner -d "$P/tuition_fakeprod" .backups/backup-2026-11-07.dump
```

1. **Pass.** Expect about 8 lock warnings and `Continue? [y/N]`. Answer `y`. Expect `SAFE TO PUSH` and `.backups/.rehearsed` to exist.

   ```bash
   bash scripts/migrate-safe.sh "$P/tuition_fakeprod"
   ```

2. **Fail, duplicate number.** Stops at migration 05. Expect `FAIL: migration failed on the copy`, the `contact_number_unique pre-flight failed` error, exit 1, and the scratch DB kept.

   ```bash
   psql "$P/tuition_fakeprod" -c "update tutor set whatsapp_number=(select whatsapp_number from student limit 1)"
   bash scripts/migrate-safe.sh "$P/tuition_fakeprod"
   ```

3. **Fail, pooler URL.** Expect failure at step 0, before any connection.

   ```bash
   bash scripts/migrate-safe.sh 'postgresql://x:y@host:25061/db'
   ```

4. **Fail, edited applied migration.** Case 2 leaves a duplicate number in `tuition_fakeprod`, so drop and recreate it with the setup block above first. Then apply the migrations, then add a comment line to one `prisma/migrations/*/migration.sql` and run the script. Expect `edited after apply`. Delete the added line by hand afterwards.

   ```bash
   DATABASE_URL="$P/tuition_fakeprod" npx prisma migrate deploy
   bash scripts/migrate-safe.sh "$P/tuition_fakeprod"
   ```

5. **Drill.** Expect `restore drill passed`.

   ```bash
   bash scripts/migrate-safe.sh --drill "$P/tuition_fakeprod"
   ```

6. **Hook gate.** Run on a branch whose `prisma/migrations` differs from `origin/main`. Expect `Migrations changed since last rehearsal`. Cancel, or use a branch with no remote so nothing is pushed.

   ```bash
   rm .backups/.rehearsed
   git push
   ```

Cleanup:

```bash
dropdb tuition_fakeprod
dropdb --if-exists $(psql "$P/postgres" -Atc "select datname from pg_database where datname like 'tuition_rehearsal_%'")
rm -f .backups/prod-*.dump .backups/.rehearsed
```

Remove `.backups/.rehearsed` after testing so the hook still demands a real run against production.

### Manual procedure

Use this if the script is unavailable. This is the method v6 was first rehearsed with.

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
