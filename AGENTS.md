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
- `src/lib/areas.ts` — helper `unusableAreaIds(db, ids)`; `src/lib/districts.ts` exports `DIVISIONS` and `DISTRICTS` (code -> {name, division}, parity-tested against DISTRICT_CODES).
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
- New helpers: `createAdmin({status, adminRole})` creates an allowlisted active SUPER_ADMIN approver as needed (admin_user CHECKs require an approver for ACTIVE/REMOVED admins); `createZoneLimitRequest(tutorId, {...})` creates a zone limit request row. `createSuperAdmin()` get-or-creates the active super admin. `createPlatformFee()` and `createFeePayment()` for fee testing. `createTuitionPackage` accepts moderationStatus, moderationNote, createdAt.

## CI workflow (.github/workflows/ci.yml)

- Runs on push/PR to `main`.
- Services: `postgis/postgis:16-3.4` Postgres container.
- Steps: `yarn install` → `yarn db:generate` → `yarn typecheck` → `yarn openapi:check` → `yarn test:ci` → `yarn build`.
- All env vars (DATABASE_URL, TEST_DATABASE_URL, token secrets, GOOGLE_CLIENT_ID, SUPER_ADMIN_EMAIL_1/2) are set in the workflow UI.
- If you add a new env var, add it to the CI config AND `.env.example`.

## Module boundaries (where agents commonly get stuck)

- **Auth routes** (`src/modules/auth/`): Google ID-token verification is frontend-driven. The backend only verifies the token via `jose`. Token signing is in `src/modules/auth/auth.service.ts`. An email listed in `super_admin_email` can sign in with POST /auth/google WITHOUT a role (no sign-up step); the first sign-in creates an ADMIN account with an ACTIVE SUPER_ADMIN admin_user. Other unknown accounts still get 404 "Sign up first".
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
- **Apply gate**: readiness comes from SQL `tutor_missing_requirements()`. Do not duplicate those checks in TypeScript. Package create uses `tutor_missing_requirements()` minus `default_requirement` (packages don't need a default set). 403 PROFILE_INCOMPLETE details.missing.
- **Education levels**: `src/lib/education.ts` is the single source for curricula, levels, labels and rules; `GET /lookups/education` serves it. Every rule the DB can enforce is also a CHECK; `src/lib/education.test.ts` has a parity test that inserts every curriculum x level x group combination and asserts TS and Postgres agree. Change both together.
- **Requirement-set subjects**: a set's subjects must be on the profile (composite FK). `syncProfileSubjects: true` adds missing ones in the same transaction. Set create/edit and PUT /tutors/me/subjects all lock the tutor row first (`lockTutor`).
- **Days per week**: `src/lib/days.ts` (`countDays`, `daysPerWeekFits`, `DAYS_PER_WEEK_MESSAGE`) is the one rule that `daysPerWeek` must not exceed the days in `availableDays`. Student requirements (create schema refine, PATCH merged check) and tutor sets (create superRefine, PATCH merged check) both use it. A PATCH that breaks it gives 400 INVALID_REQUIREMENT with `fields: ["daysPerWeek"]`. Postgres does not enforce this rule. Only the 1..7 range is a CHECK: `tr_days_per_week_range` on `tutor_requirement.days_per_week` (nullable; null = any number of the available days), in `constraints.sql` and migration `20261118000100_set_days_per_week`. Student requirements accept `availableDays` (OPEN create defaults it to 127). Package PATCH re-checks the same rule.
- **Zones** (`src/modules/zone/`): centers written via raw SQL with geog_source PIN; never expire (weekly cron skips tutor_zone). Quota enforced by trigger `tutor_zone_quota_trg` -> 409 ZONE_LIMIT_REACHED. Zone list items gain packageIds (OPEN packages using the zone). DELETE zone response gains affectedPackages [{ id, title, teachesOnline, remainingZoneCount }]; a package left with no zone and not online stays open but no longer shows in nearby browse.
- **Admin routes** (`src/modules/admin/*.routes.ts`, `src/modules/lookups/subjects.routes.ts`, `src/modules/lookups/areas.routes.ts`, `src/modules/admin/areas.routes.ts`): registered in `src/server.ts` under `/api/v1/admin` (subjects also at `/api/v1/subjects` and `/api/v1/admin/subjects`; areas at `/api/v1/areas` and `/api/v1/admin/areas`). Guarded by `requireAdmin()` (role ADMIN, admin_user.status ACTIVE) or `requireSuperAdmin()` (ACTIVE + admin_role SUPER_ADMIN, else 403), both in `src/plugins/auth.ts`. Every admin plugin response gets `private, no-store` via `privateNoStore(app)` in `src/lib/admin.ts`. Audit rows written by `writeAudit(tx, …)` in `src/lib/admin.ts`, in the same transaction (actions: subject.create, subject.update, area.create, area.update, admin.approve, admin.remove, account.block, account.unblock, package.moderate, fee.create, fee.update, fee.payment, payment.reverse, setting.update, zone_limit_request.decide). Admin code never writes `account.status` (account_block trigger sets BLOCKED) nor `platform_fee.amount_paid`/`status` for payments (fee_payment triggers). Package moderation flow: POST /packages creates PENDING; GET /admin/packages lists by moderationStatus (PENDING oldest first, APPROVED/REJECTED newest first); POST /admin/packages/:id/moderate decides (409 PACKAGE_ALREADY_MODERATED unless PENDING). Inactive areas are hidden from GET /areas; students, tutors and requirements that already reference one keep it; an inactive area cannot be newly chosen.
- **Rate limits**: per-route limits use `accountRateLimit(max, window, message?)` from `src/lib/rate-limit.ts` (key = account id, else IP; runs as route-level onRequest hook after global auth hook, so request.account is set). Zone and zone-request routes (#129-136) have per-route limits; other routes still only have the global 100/min limit. Zone limit requests also have a DB-backed daily cap (3/day) enforced in the table.
- **Applications** (`src/modules/application/`): read/write services split. Every transition in one transaction that locks the application row FOR UPDATE and, for confirm/reopen, the listing row. `allowedActions` computed server-side by `computeAllowedActions`. Confirm auto-rejects other PENDING applications on the same listing and the listing stays OPEN but is "closed" for new applications while it has a CONFIRMED/COMPLETED one → 409 APPLICATION_CLOSED. Placement fee = commission_percent × monthly salary (requirement) or package total price (package), due 7 days after confirmation, skipped when the setting is missing/0 or salary is null. Cancel voids an unpaid DUE fee. Counterpart contact only after CONFIRMED. Outbox rows and their dedupe keys: `application_received:{applicationId}:{appliedAt.getTime()}`, `application_confirmed:{applicationId}`, `payment_reminder:{feeId}:{YYYY-MM-DD Dhaka date}`. No matching score is computed yet (match_* columns stay null). Test files: `application.test.ts`, `requirement-browse.test.ts`, `package.test.ts`, `package-write.test.ts`.
- **Browse** (`src/modules/requirement/requirement-browse.*.ts`, `src/modules/package/package.routes.ts`): GET /requirements nearby rule via tutor zones + tutor_area fallback, distance rounded to 0.5 km, no coordinates/contact in responses. GET /packages and /packages/:id for browse and detail; tutor writes are under Package endpoints below. Package exposes zoneCount, not zone ids. Browse filters match when the package covers them: curriculum in curricula, levelCode between levelMin and levelMax, subjectId among its subjects. scope=nearby: online packages, or the student's pin inside one of THAT package's zones. No usable pin: online packages only, locationMissing true. Package create/list mine/edit/close are built: POST /packages (creates moderationStatus PENDING; students see only APPROVED; 403 until tutor_missing_requirements() empty minus default_requirement), GET /packages/mine, PATCH /packages/:id (OPEN only, merged education re-checked; edits to APPROVED packages stay live; editing a REJECTED package resubmits it (PENDING, note cleared), students with PENDING/CONFIRMED requests get PACKAGE_UPDATED alert), POST /packages/:id/close (OPEN to CLOSED, PENDING requests become EXPIRED with PACKAGE_CLOSED alert). PUT /packages/:id/requirement folded into PATCH. Admin moderation endpoints #93/#94 built.
- **Set matching** (`src/modules/requirement/set-match.ts`): `setMatchesRequirementSql()` is the one SQL fragment for "does tutor set `tr` cover requirement `r` (student pin `sl`)": curriculum in the set's curricula, level within levelMin..levelMax, a shared subject, and the student pin inside one of the set's zones (no zones = the nearby rule). Used by GET /requirements `scope=set&setId` (manual filters ignored; foreign or archived set → 404) and by the `tutorSet` pick on GET /applications/:id. It is a filter, not the matching score.
- **In-app alerts** (`src/modules/notification/`, table `app_notification`): one row per application event for the other party (kinds in `AppNotificationKind`; LISTING_FILLED goes to applicants auto-rejected by a confirm), written in the same transaction as the transition in `application.write.service.ts`. Package edits and closes write PACKAGE_UPDATED (students with a PENDING or CONFIRMED request) and PACKAGE_CLOSED (students whose PENDING request expired) in `package.service.ts`. Names are joined at read time. Never sent anywhere and unrelated to the WhatsApp `notification_log` outbox. New tables go in the TRUNCATE list in `src/tests/setup.ts`.
- **Tutor instituteName**: nullable column; trimmed 1-120 in the API and optional on POST /tutors/me so older web builds keep working (the web form requires it). Returned on the tutor profile, /me, public profile, search, nearby (which also returns areas and subjects) and application `tutor`/`tutorProfile`.
- **Fees cron** (`src/cron/fee-reminders.ts`): daily PAYMENT_REMINDER outbox rows from the due date until 21 days after confirmation; "Unpaid" is derived, never stored; payment stays possible.
- **PUT /tutors/me/subjects**: 409 REQUIREMENT_LOSES_LAST_SUBJECT now when removal would empty an active set OR an OPEN package; details { requirementIds, packageIds } (both always present).
- **Tutor requirement sets**: mappedPackageCount removed from the response; archiving a set is never blocked by packages; error code REQUIREMENT_IN_USE removed.
- **Package schema**: title (1-80), description (1-600, what it covers), coverage (FULL_CURRICULUM | PARTIAL), durationWeeks (1-104), price (BDT for the WHOLE package, max 5,000,000), subjectIds (min 1, table package_subject, composite FK to tutor_subject), levelMin/levelMax, curricula (min 1), academicGroups, admissionTargets, timeFrom/timeTo (to after from), availableDays, daysPerWeek (nullable, must fit the days), maxStudents (1-50), availableFrom, teachesOnline, zoneIds (the tutor's own zones, table package_zone; empty only when teachesOnline). Optional syncProfileSubjects adds subjects missing from the profile. REMOVED: subjectId, areaId, requirementId, levelCode, curriculum, academicGroup, isRetaker, levelNote, timeOfDay, expectedSalary, studentCount.
- **Package endpoints**: POST /packages (#51) readiness gate is tutor_missing_requirements() minus default_requirement. 400 INVALID_REQUIREMENT details.fields ["subjectIds"] or ["zoneIds"] when a subject is not on the profile / a zone is not the tutor's. Creates moderationStatus PENDING (students see only after approval; browse/detail/apply require APPROVED). GET /packages/mine (#53): MyPackage = Package + zoneIds, moderationNote, updatedAt, pendingRequestCount, requestCount. GET /packages and GET /packages/:id: Package exposes zoneCount, not zone ids. PATCH /packages/:id (#55): partial; merged values re-checked with the same rules; a violation is 400 VALIDATION_ERROR with top-level issues (validationIssuesError helper in src/lib/errors.ts; error handler in src/server.ts passes AppError.issues through). subjectIds/zoneIds replace the lists. Still OPEN only (409 LISTING_NOT_OPEN), PACKAGE_UPDATED alert unchanged. On REJECTED package, PATCH resubmits (moderationStatus PENDING, moderationNote null); edits to APPROVED packages stay live (admin notice/revert planned). Application target (ApplicationTarget): new nullable title, price, durationWeeks (set for PACKAGE targets, null for REQUIREMENT). For PACKAGE targets areaId, curriculum, levelCode, academicGroup and salary are null; timeOfDay is the package start time. ApplicationTutorSet.matchedBy is MATCH | DEFAULT only; package applications have tutorSet null.
- **Placement fee on confirm**: commission_percent of the requirement's monthly salary, or of the package's TOTAL price.
- **Migration 20261119000200_package_offer**: deletes existing package rows; refuses to run if package applications exist; drops the set-archive trigger tr_block_archive and package_requirement_same_tutor.

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