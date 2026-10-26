# tuition-api — OpenCode Agent Quickstart

This file captures the essential, non-obvious guidance an agent needs to work in this repo without breaking things.

## Developer Commands (from package.json)

| Command | Purpose |
|---------|---------|
| `yarn install` | Install dependencies |
| `yarn dev` | Start dev server with watch (tsx watch --env-file=.env src/server.ts) |
| `yarn build` | Build production bundle to `dist/` (tsup src/server.ts src/cron/weekly-location-expiry.ts) |
| `yarn start` | Run production bundle (node dist/server.js) |
| `yarn db:migrate:create` | Create new empty migration (`prisma migrate dev --create-only`) |
| `yarn db:migrate` | Apply migrations in dev (`prisma migrate dev`) |
| `bash scripts/migrate.sh` | Apply migrations in production (pre-deploy job) |
| `npx prisma migrate deploy` | Apply migrations locally/manually |
| `yarn db:generate` | Regenerate Prisma client |
| `yarn db:seed` | Run seed script (`tsx --env-file-if-exists=.env src/seed/index.ts`) |
| `yarn db:studio` | Open Prisma Studio |
| `yarn lint` / `yarn lint:fix` | Biome lint/check |
| `yarn format` | Biome format (write) |
| `yarn typecheck` | TypeScript (`tsc --noEmit`) |
| `yarn test` | Vitest (watch mode) |
| `yarn test:ci` | Vitest (single run, no watch) |
| `yarn cron:weekly-location-expiry` | Run weekly location-expiry cron (`tsx --env-file-if-exists=.env src/cron/weekly-location-expiry.ts`) |
| `yarn prepare` | Husky setup (`husky || true`) |

## Prisma / DB (critical)

- **PostGIS must be installed** before running migrations or seeds: `CREATE EXTENSION IF NOT EXISTS postgis;` on the target DB.
- **`prisma/constraints.sql`** contains CHECKs, triggers, and partial indexes that Prisma cannot model. It is appended to the **end** of the generated initial migration. On future migrations, review the generated SQL and **never accept a DROP INDEX** for indexes named in `constraints.sql`.
- The test setup (`src/tests/setup.ts`) runs `npx prisma migrate deploy` before each test suite. Tests use a real PostgreSQL DB with PostGIS.
- Test DB: set `TEST_DATABASE_URL` in `.env` (format: `postgresql://user:password@localhost:5432/tuition_test?sslmode=disable`). Tests use `TEST_DATABASE_URL` when set, otherwise `DATABASE_URL`.
- Vitest config uses `pool: "threads"` and `fileParallelism: false` — tests are not parallelized.

## Lint / Typecheck / Test order

The pre-push hook and CI enforce: **`lint -> typecheck -> test:ci -> build`**. Always run in this order on a PR. Skipping any step may cause the hook or CI to fail.

## Environment variables (from .env.example)

Required for the app to start:
- `DATABASE_URL`
- `ACCESS_TOKEN_SECRET` (min 32 chars)
- `REFRESH_TOKEN_SECRET` (min 32 chars)

Required once auth/files/notifications are used:
- `GOOGLE_CLIENT_ID`
- `R2_ENDPOINT`, `R2_REGION`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_PUBLIC_URL_PREFIX`
- `N8N_WEBHOOK_URL`, `N8N_WEBHOOK_SECRET`
- `SUPER_ADMIN_EMAIL_1`, `SUPER_ADMIN_EMAIL_2`

## Project structure (high-level)

- `src/config/env.ts` — Zod-validated env config (do not rename fields; the schema is the source of truth).
- `src/lib/prisma.ts` — Prisma singleton with CA cert fallback (`ca-certificate.crt` at repo root).
- `src/modules/` — route handlers by domain (auth, tutor, student, location, etc.).
- `src/plugins/` — Fastify plugins (auth, health).
- `src/server.ts` — app entry point; registers all plugins and routes.
- `src/seed/index.ts` — seeds areas, subjects, and super-admin emails.
- `src/cron/weekly-location-expiry.ts` — weekly cron that soft-warns (≥21 days) and hard-expiries (≥28 days) tutor/student locations.
- `dist/` — production build output.
- `prisma/migrations/` — generated migrations; `prisma/constraints.sql` is hand-edited and appended.

## Testing quirks

- Tests hit a **real PostgreSQL database** with PostGIS enabled. Do not run tests against an in-memory or empty DB — they will fail.
- The test setup truncates 50+ tables in `beforeEach`. If you add a new model/table, add it to the TRUNCATE statement in `src/tests/setup.ts`.
- Factories in `src/tests/helpers.ts` (createAccount, createStudentProfile, createTutorProfile, etc.) are the canonical way to create test data.
- `setTutorLocation` and `setStudentLocation` in `src/tests/helpers.ts` insert location rows with PostGIS `ST_SetSRID(ST_MakePoint(...))`.
- To add a new test helper, add it to `src/tests/helpers.ts` — do not create parallel test data utilities.

## CI workflow (.github/workflows/ci.yml)

- Runs on push/PR to `main`.
- Services: `postgis/postgis:16-3.4` Postgres container.
- Steps: `yarn install` → `yarn db:generate` → `yarn typecheck` → `yarn test:ci` → `yarn build`.
- All env vars (DATABASE_URL, TEST_DATABASE_URL, token secrets, GOOGLE_CLIENT_ID, SUPER_ADMIN_EMAIL_1/2) are set in the workflow UI.
- If you add a new env var, add it to the CI config AND `.env.example`.

## Module boundaries (where agents commonly get stuck)

- **Auth routes** (`src/modules/auth/`): Google ID-token verification is frontend-driven. The backend only verifies the token via `jose`. Token signing is in `src/modules/auth/auth.service.ts`.
- **Location**: `tutor_location` and `student_location` use PostGIS `GEOGRAPHY(POINT,4326)`. Coordinates are inserted via raw `ST_SetSRID(ST_MakePoint(lng, lat))` — do not switch to Prisma native geometry.
- **Files**: Cloudflare R2 (S3-compatible). Presigned URLs are generated by `@aws-sdk/s3-request-presigner`. Bucket and credentials come from env vars.
- **Cron**: `src/cron/weekly-location-expiry.ts` calls `runLocationExpiry` from `src/modules/location/location.service.ts`. Runs weekly on DO App Platform at 03:00 UTC.

## What to avoid (quick list)

- Do not `prisma migrate reset` in shared/dev env — it destroys data.
- Do not accept Prisma-generated `DROP INDEX` for indexes named in `prisma/constraints.sql`.
- Do not run `yarn test` without PostGIS on the test database.
- Do not forget to add new tables to the TRUNCATE in `src/tests/setup.ts` before committing.
- Do not modify `biome.json` rules without running `yarn lint` to verify.