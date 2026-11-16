# tuition-api — OpenCode Agent Quickstart

This file captures the essential, non-obvious guidance an agent needs to work in this repo without breaking things.

## Developer Commands (from package.json)

| Command | Purpose |
|---------|---------|
| `yarn install` | Install dependencies |
| `yarn dev` | Start dev server with watch (tsx watch --env-file=.env src/server.ts) |
| `yarn build` | Build production bundle to `dist/` (tsup src/server.ts src/cron/weekly-location-expiry.ts src/cron/fee-reminders.ts) |
| `yarn start` | Run production bundle (node dist/server.js) |
| `yarn cron:fee-reminders` | Run fee-reminder cron manually (`tsx --env-file-if-exists=.env src/cron/fee-reminders.ts`) |
| `yarn db:migrate:create` | Create new empty migration (`prisma migrate dev --create-only`) |
| `yarn db:migrate` | Apply migrations in dev (`prisma migrate dev`) |
| `bash scripts/migrate.sh` | Apply migrations in production (pre-deploy job) |
| `npx prisma migrate deploy` | Apply migrations locally/manually |
| `yarn db:generate` | Regenerate Prisma client |
| `yarn db:seed` | Run seed script (`tsx --env-file-if-exists=.env src/seed/index.ts`) |
| `yarn db:studio` | Open Prisma Studio |
| `yarn lint` / `yarn lint:fix` | Biome lint/check |
| `yarn lint:sql` | Squawk lint of new migrations (see Migration safety) |
| `yarn format` | Biome format (write) |
| `yarn typecheck` | TypeScript (`tsc --noEmit`) |
| `yarn test` | Vitest (watch mode) |
| `yarn test:ci` | Vitest (single run, no watch) |
| `yarn cron:weekly-location-expiry` | Run weekly location-expiry cron (`tsx --env-file-if-exists=.env src/cron/weekly-location-expiry.ts`) |
| `yarn openapi:export` | Write committed `openapi.json` at repo root from running app |
| `yarn openapi:check` | Fail when `openapi.json` is stale (CI + pre-push) |
| `yarn prepare` | Husky setup (`husky || true`) |

## Prisma / DB (critical)

- **PostGIS must be installed** before running migrations or seeds: `CREATE EXTENSION IF NOT EXISTS postgis;` on the target DB.
- **`prisma/constraints.sql`** is the FINAL-STATE reference for CHECKs, triggers, and partial indexes that Prisma cannot model. It is not appended to any migration. Deployed databases get changes only via migrations, so every change to `constraints.sql` needs a migration carrying the same SQL (v6: `20261107000300_v6_constraints`, `20261107000400_v6_validate`, `20261107000500_v6_contact_unique`, `20261111000100_pr1_hardening`; PR B: `20261116000300_edu_constraints`, `20261116000400_edu_validate`).
- Review generated SQL and **never accept a DROP INDEX** for: `tutor_name_trgm`, `notification_due_idx`, `tutor_location_geog_gist_idx`, `student_location_geog_gist_idx`, `tutor_zone_center_gix`, `dispute_raised_by_idx`, `tutor_requirement_one_default`, `zlr_one_pending_per_tutor`, `fee_payment_gateway_ref_uniq`. Prisma also proposes dropping DEFAULTs on location ids; ignore that.
- The test setup (`src/tests/setup.ts`) runs `npx prisma migrate deploy` before each test suite. Tests use a real PostgreSQL DB with PostGIS.
- Test DB: set `TEST_DATABASE_URL` in `.env` (format: `postgresql://user:password@localhost:5432/tuition_test?sslmode=disable`). Tests use `TEST_DATABASE_URL` when set, otherwise `DATABASE_URL`.
- Vitest config uses `pool: "threads"` and `fileParallelism: false` — tests are not parallelized.
- **Migration safety:** rehearse pending migrations with `bash scripts/migrate-safe.sh '<prod direct url>'` (`--drill` = restore check only). It dumps prod, restores to a local scratch DB, applies the migrations there, and writes `.backups/.rehearsed`. Prod is only read. Full guide: `docs/migrations.md`.
- **Pre-push gate:** `.husky/pre-push` blocks a push that changes `prisma/migrations` unless `.backups/.rehearsed` matches the current migration files. `git push --no-verify` skips ALL checks; never use it for an unrehearsed migration.
- **Squawk:** `yarn lint:sql` runs in CI on new migrations only. The 9 existing ones are in `excluded_paths` in `.squawk.toml`; never add new migrations there. Silence a deliberate warning with `-- squawk-ignore <rule>`.
- **Backups:** `.backups/` is gitignored and holds PII dumps. Dumps older than 14 days are deleted automatically.
- **Agents never run `migrate-safe.sh` against production.** It needs the user's prod URL and a DO Trusted Sources IP; ask the user first.

## Lint / Typecheck / Test order

The pre-push hook and CI enforce: **`lint -> typecheck -> openapi:check -> test:ci -> build`**. Always run in this order on a PR. Skipping any step may cause the hook or CI to fail. The pre-push hook also runs the migration rehearsal gate first when `prisma/migrations` changed.

## Environment variables (from .env.example)

Required for the app to start:
- `DATABASE_URL` is the direct URL (port 25060), used by migrations and the Prisma CLI. There is no `DATABASE_DIRECT_URL`; do not add one.
- `DATABASE_POOL_URL` is the app's pool URL (optional; falls back to `DATABASE_URL`). The app owns its `pg.Pool` (`src/lib/prisma.ts`): max 3 per process (override with `?connection_limit=`), 5 s connect timeout, 10 s `statement_timeout` on direct URLs.
- `ACCESS_TOKEN_SECRET` (min 32 chars)
- `REFRESH_TOKEN_SECRET` (min 32 chars)

Required once auth/files/notifications are used:
- `GOOGLE_CLIENT_ID`
- `R2_ENDPOINT`, `R2_REGION`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_PUBLIC_URL_PREFIX`
- `N8N_WEBHOOK_URL`, `N8N_WEBHOOK_SECRET`
- `SUPER_ADMIN_EMAIL_1`, `SUPER_ADMIN_EMAIL_2`

Optional:
- `API_DOCS` — `true` | `false`. Enables Swagger UI at `/docs`. Default: on outside production, off in production.

## Project structure (high-level)

- `src/config/env.ts` — Zod-validated env config (do not rename fields; the schema is the source of truth).
- `src/lib/prisma.ts` — Prisma singleton with CA cert fallback (`ca-certificate.crt` at repo root).
- `src/modules/` — route handlers by domain (auth, tutor, student, location, etc.).
- `src/plugins/` — Fastify plugins (auth, health).
- `src/openapi/` — Swagger/OpenAPI 3.1 plugin, docs, export, and contract tests.
- `src/server.ts` — app entry point; registers all plugins and routes.
- `src/seed/index.ts` — seeds areas, subjects, and super-admin emails.
- `src/cron/weekly-location-expiry.ts` — weekly cron that soft-warns (≥21 days) and hard-expiries (≥28 days) tutor/student locations.
- `src/cron/fee-reminders.ts` — daily cron that enqueues PAYMENT_REMINDER outbox rows for unpaid placement fees.
- `dist/` — production build output.
- `prisma/migrations/` — generated migrations; `prisma/constraints.sql` is the hand-edited final-state reference (see Prisma / DB).

## Testing quirks

- Tests hit a **real PostgreSQL database** with PostGIS enabled. Do not run tests against an in-memory or empty DB — they will fail.
- The test setup truncates 50+ tables in `beforeEach`. If you add a new model/table, add it to the TRUNCATE statement in `src/tests/setup.ts`. The list already includes the v6 tables.
- `platform_setting` is seeded by migration, so TRUNCATE CASCADE wipes it. `setup.ts` re-seeds it in `beforeEach`; keep that when editing the list.
- `prisma.config.ts` uses `TEST_DATABASE_URL` as the shadow DB, so `migrate dev` resets the test DB.
- Factories in `src/tests/helpers.ts` (createAccount, createStudentProfile, createTutorProfile, etc.) are the canonical way to create test data.
- `setTutorLocation` and `setStudentLocation` in `src/tests/helpers.ts` insert location rows with PostGIS `ST_SetSRID(ST_MakePoint(...))`.
- To add a new test helper, add it to `src/tests/helpers.ts` — do not create parallel test data utilities.
- New helpers: `createAdmin({status, adminRole})` creates an allowlisted active SUPER_ADMIN approver as needed (admin_user CHECKs require an approver for ACTIVE/REMOVED admins); `createZoneLimitRequest(tutorId, {...})` creates a zone limit request row.

## CI workflow (.github/workflows/ci.yml)

- Runs on push/PR to `main`.
- Services: `postgis/postgis:16-3.4` Postgres container.
- Steps: `yarn install` → `yarn db:generate` → `yarn typecheck` → `yarn openapi:check` → `yarn test:ci` → `yarn build`.
- All env vars (DATABASE_URL, TEST_DATABASE_URL, token secrets, GOOGLE_CLIENT_ID, SUPER_ADMIN_EMAIL_1/2) are set in the workflow UI.
- If you add a new env var, add it to the CI config AND `.env.example`.

## Module boundaries (where agents commonly get stuck)

- **Auth routes** (`src/modules/auth/`): Google ID-token verification is frontend-driven. The backend only verifies the token via `jose`. Token signing is in `src/modules/auth/auth.service.ts`.
- **Location**: `tutor_location` and `student_location` use PostGIS `GEOGRAPHY(POINT,4326)`. Coordinates are inserted via raw `ST_SetSRID(ST_MakePoint(lng, lat))` — do not switch to Prisma native geometry.
- **Files**: Cloudflare R2 (S3-compatible). Presigned URLs are generated by `@aws-sdk/s3-request-presigner`. Bucket and credentials come from env vars.
- **Cron**: `src/cron/weekly-location-expiry.ts` calls `runLocationExpiry` from `src/modules/location/location.service.ts`. Runs weekly on DO App Platform at 03:00 UTC.
- **Public reads**: use `tutorPublicSelect` (default-deny); never `include` a whole tutor row. Public GETs send `Cache-Control` only for anonymous callers; signed-in callers get `private, no-store`. See `src/plugins/cache.ts`.
- **Account deletion**: `softDeleteAccount` is one transaction (tombstones, session revoke, closes OPEN listings, withdraws PENDING applications). Sign-in of a deleted account is 403; a Google sign-up reactivates it and restores the numbers. `verifyAccessToken` rejects non-ACTIVE accounts. Ban spam users with BLOCKED, not DELETED.
- **BigInt**: `src/lib/bigint.ts` adds `BigInt.prototype.toJSON`; keep it imported first in `src/server.ts`.
- **Transactions**: never `Promise.all` queries on one interactive `tx` client; pg warns and Prisma serialises them anyway.
- **Shutdown**: SIGTERM drains Fastify then `pool.end()` (10 s hard exit) in `src/server.ts`.
- **Listing**: `is_listed` is written ONLY by `recompute_is_listed()` (SQL). Never set it by hand in services.
- **Location payload**: profile routes take a nested `location {lat, lng, addressText, district, placeId?}` (`src/modules/location/location.schema.ts`); `district` is normalized by `src/lib/districts.ts`. Write only through `upsertLocation`.
- **Location rows** carry `geog_source`. `PIN` never expires; the cron only touches `PLACES`. Geography and zone writes go through raw SQL, because Prisma cannot write `Unsupported` types.
- **Contact numbers**: `phone_number` is required on student and tutor; `whatsapp_number` is optional (NULL allowed, cleared by PATCH `whatsappNumber: null`). Both are globally unique across student and tutor, enforced by trigger `contact_number_guard` and service `assertContactNumbersFree` (409 `PhoneInUse` / `WhatsappInUse`). The same account may reuse a number; `deleted:` tombstones are ignored. The services never copy one number into the other.
- **Apply gate**: readiness comes from SQL `tutor_missing_requirements()`. Do not duplicate those checks in TypeScript.
- **Education levels**: `src/lib/education.ts` is the single source for curricula, levels, labels and rules; `GET /lookups/education` serves it. Every rule the DB can enforce is also a CHECK; `src/lib/education.test.ts` has a parity test that inserts every curriculum x level x group combination and asserts TS and Postgres agree. Change both together.
- **Requirement-set subjects**: a set's subjects must be on the profile (composite FK). `syncProfileSubjects: true` adds missing ones in the same transaction. Set create/edit and PUT /tutors/me/subjects all lock the tutor row first (`lockTutor`).
- **Zones** (`src/modules/zone/`): centers written via raw SQL with geog_source PIN; never expire (weekly cron skips tutor_zone). Quota enforced by trigger `tutor_zone_quota_trg` -> 409 ZONE_LIMIT_REACHED.
- **Admin routes** (`src/modules/admin/zone-requests.*`): guarded by `requireAdmin()` in `src/plugins/auth.ts` (role ADMIN AND admin_user.status ACTIVE; PENDING/REMOVED admins get 403; MFA not enforced). Decide endpoint runs in one transaction: locks request then tutor, writes audit_log (action zone_limit_request.decide) and notification_log outbox row (event ZONE_LIMIT_DECIDED, dedupe key zone_limit_decided:{id}).
- **Rate limits**: per-route limits use `accountRateLimit(max, window, message?)` from `src/lib/rate-limit.ts` (key = account id, else IP; runs as route-level onRequest hook after global auth hook, so request.account is set). Zone and zone-request routes (#129-136) have per-route limits; other routes still only have the global 100/min limit. Zone limit requests also have a DB-backed daily cap (3/day) enforced in the table.
- **Applications** (`src/modules/application/`): read/write services split. Every transition in one transaction that locks the application row FOR UPDATE and, for confirm/reopen, the listing row. `allowedActions` computed server-side by `computeAllowedActions`. Confirm auto-rejects other PENDING applications on the same listing and the listing stays OPEN but is "closed" for new applications while it has a CONFIRMED/COMPLETED one → 409 APPLICATION_CLOSED. Placement fee = commission_percent × monthly salary, due 7 days after confirmation, skipped when the setting is missing/0 or salary is null. Cancel voids an unpaid DUE fee. Counterpart contact only after CONFIRMED. Outbox rows and their dedupe keys: `application_received:{applicationId}:{appliedAt.getTime()}`, `application_confirmed:{applicationId}`, `payment_reminder:{feeId}:{YYYY-MM-DD Dhaka date}`. No matching score is computed yet (match_* columns stay null). Test files: `application.test.ts`, `requirement-browse.test.ts`, `package.test.ts`.
- **Browse** (`src/modules/requirement/requirement-browse.*.ts`, `src/modules/package/package.routes.ts`): GET /requirements nearby rule via tutor zones + tutor_area fallback, distance rounded to 0.5 km, no coordinates/contact in responses. GET /packages and /packages/:id read-only — package create/edit/close are not built yet.
- **Fees cron** (`src/cron/fee-reminders.ts`): daily PAYMENT_REMINDER outbox rows from the due date until 21 days after confirmation; "Unpaid" is derived, never stored; payment stays possible.

## OpenAPI / Swagger

- `@fastify/swagger` (OpenAPI 3.1) is registered in `buildApp` before all routes via `registerOpenApi(app)`; zod schemas are the source of truth (`fastify-type-provider-zod` jsonSchemaTransform).
- Swagger UI at `/docs`, JSON at `/docs/json`. On by default outside production; off in production unless env `API_DOCS=true`.
- Every route spreads `...routeDocs({ tag, summary, description?, auth, errors?, rateLimit?, noContent?, deferred? })` into its `schema`. `auth` is `"public" | "optional" | "any" | "admin" | role list`. Error responses (shared `ErrorResponse` component) and 204s are injected only into the document by the swagger transform; the runtime serializer never sees them. 400 is added when a route validates input, 401 for signed-in routes, 403 for role/admin routes, 501 for deferred, 429 and 500 everywhere.
- Every route returning JSON must have a `response` zod schema. The zod serializer validates responses at runtime (strips undeclared fields, 500 on mismatch), so enum fields must use Prisma/education enums, `Date` objects use `z.date()`, un-converted Prisma `Decimal` uses `z.any().meta({ type: "string" })`.
- Reusable schemas get `.meta({ id: "PascalName" })`; request bodies are named by action without a suffix because the generator appends `Input` (e.g. id `"CreateZone"` → component `"CreateZoneInput"`). Unreferenced components are pruned. Paths are documented without trailing slash.
- `yarn openapi:export` writes the committed `openapi.json` at the repo root; `yarn openapi:check` fails when stale. CI runs openapi:check after typecheck; `.husky/pre-push` runs it too. `src/openapi/openapi.test.ts` fails if any route lacks tag/summary/auth/2xx schema (deferred 501 stubs exempt).
- Response schemas double as an allowlist: `GET /me` deliberately leaves out `googleSub` and `mfaSecretEnc`. Throw catalogue errors (`appError`, `notFound`); never `reply.send({ error, message })`, which has no `code`.

## Schema v6

- Plan and migration order: `.misc/MIGRATION_PLAN_v6.md` (pre-flight: `.misc/pre-flight.sql`, `.misc/v6-preflight.sh`). Launch steps: `before-launch-checklist.md`, section 12.
- `endpoints.md` in this repo is listed in `.gitignore`, so its changes are not committed. The copy in `../tution-media/endpoints.md` is the other half and must stay in sync, except for its State column. The live, complete contract for implemented endpoints is `/docs` (Swagger UI) and `openapi.json` at the repo root.
- Transitional: the phone fill triggers (`student_phone_fill_trg`, `tutor_phone_fill_trg`, function `phone_number_fill()`) are dropped by the contract migration after the feature release (R3).

## What to avoid (quick list)

- Do not `prisma migrate reset` in shared/dev env — it destroys data.
- Do not accept Prisma-generated `DROP INDEX` for the indexes listed under Prisma / DB.
- Do not run `yarn test` without PostGIS on the test database.
- Do not forget to add new tables to the TRUNCATE in `src/tests/setup.ts` before committing.
- Do not modify `biome.json` rules without running `yarn lint` to verify.