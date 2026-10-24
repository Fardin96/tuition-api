# tuition-api

Backend for the Tuition Media / Masters Hub app.

## Stack

- **Runtime:** Node.js 22, TypeScript, ESM
- **Framework:** Fastify 5 with Zod type provider
- **ORM / DB:** Prisma 7 + PostgreSQL 13+ (uses `@prisma/adapter-pg`)
- **Auth:** Google ID-token verification (frontend-driven OAuth), JWT access tokens, SHA-256 hashed refresh tokens
- **Files:** Cloudflare R2 (S3-compatible object storage)
- **Notifications:** n8n webhook → WhatsApp
- **Hosting:** DigitalOcean App Platform, region `blr` (Bangalore) — see `.do/app.yaml`

## Local setup

```bash
# 1. Node 22 (already pinned in .nvmrc)
nvm use        # or ensure node -v == v22.x

# 2. Install deps
yarn install

# 3. Postgres
# A local Postgres 17 was installed via Homebrew for this project.
# To start it later:
#   brew services start postgresql@17
#
# Default dev DB (already created). Add ?sslmode=disable for local Postgres
# when the app is not configured to use TLS:
#   DATABASE_URL="postgresql://user:password@localhost:5432/tuition_dev?sslmode=disable"

# 4. Env
cp .env.example .env
# Edit .env and fill in real secrets (Google OAuth, R2, n8n, tokens, super-admin emails).

# 5. DB schema + constraints (postgis must be installed first)
psql "$DATABASE_URL" -c "CREATE EXTENSION IF NOT EXISTS postgis;"
yarn db:generate
yarn db:migrate

# 6. Run dev server
yarn dev

# Health check
curl http://localhost:3000/api/v1/health
```

## Important: schema constraints

`prisma/constraints.sql` contains CHECKs, triggers, and partial indexes that Prisma cannot model. It is appended to the **end** of the generated initial migration (`prisma/migrations/20261020122427_init/migration.sql`) before applying. On future migrations, review the generated SQL and **never accept a DROP INDEX** for indexes named in `constraints.sql`.

## Scripts

| Script | Purpose |
|--------|---------|
| `yarn dev` | Start dev server with watch |
| `yarn build` | Build production bundle to `dist/` |
| `yarn start` | Run production bundle (env vars injected by host) |
| `yarn db:migrate:create` | Create a new empty migration |
| `yarn db:migrate` | Apply migrations in dev |
| `bash scripts/migrate.sh` | Apply migrations in production (run automatically by the pre-deploy job) |
| `npx prisma migrate deploy` | Apply migrations locally/manually |
| `yarn db:generate` | Regenerate Prisma client |
| `yarn db:seed` | Run seed script |
| `yarn db:studio` | Open Prisma Studio |
| `yarn lint` / `yarn lint:fix` | Biome |
| `yarn typecheck` | TypeScript |
| `yarn test` | Vitest (watch) |
| `yarn test:ci` | Vitest (single run) |
| `yarn cron:weekly-location-expiry` | Run the weekly location-expiry cron manually |

## Deploy to DigitalOcean App Platform

1. The App Platform app uses an **existing** DigitalOcean managed Postgres cluster — set `DATABASE_URL` and `DATABASE_POOL_URL` in the UI or `.do/app.yaml`.
2. Enable the `postgis` extension on the managed database before first deploy:
   ```bash
   psql "$DATABASE_URL" -c "CREATE EXTENSION IF NOT EXISTS postgis;"
   ```
3. Create a Cloudflare R2 bucket and API token for file uploads.
4. Set up a Google OAuth client and add the production `GOOGLE_CLIENT_ID` to `.do/app.yaml`.
5. Fill in `.do/app.yaml` placeholders (GitHub repo, R2 credentials, token secrets, DB URLs).
6. Install `doctl` and run:
   ```bash
   doctl apps create --spec .do/app.yaml
   ```
7. Migrations run automatically before each deploy via the `migrate` pre-deploy job declared in `.do/app.yaml`. To run them manually:
   ```bash
   bash scripts/migrate.sh
   # or, against the managed DB from your local machine:
   DATABASE_URL="<direct-db-url>" npx prisma migrate deploy
   ```

### Weekly location-expiry cron

A single DO App Platform job runs every Sunday at 03:00 UTC:

- Soft warning at **21 days**: sets `needs_readdress = true` on `tutor_location` / `student_location`.
- Hard expiry at **28 days**: nulls `geog` and keeps `needs_readdress = true`, hiding the tutor/student from geo search.

No external API call is required. The job is declared as `weekly-location-expiry` in `.do/app.yaml`.

## Testing

Tests use **Vitest** and hit a real PostgreSQL database.

1. Ensure Postgres has the `postgis` extension:
   ```bash
   psql -d template1 -c "CREATE EXTENSION IF NOT EXISTS postgis;"
   ```
2. Create a test DB (separate from `tuition_dev`):
   ```bash
   createdb tuition_test
   ```
3. Add a test database URL to `.env` with `sslmode=disable`. Either `DATABASE_URL` or `TEST_DATABASE_URL` works; tests use `TEST_DATABASE_URL` when set, otherwise `DATABASE_URL`:
   ```bash
   DATABASE_URL="postgresql://user:password@localhost:5432/tuition_test?sslmode=disable"
   # optional override:
   # TEST_DATABASE_URL="postgresql://user:password@localhost:5432/tuition_test?sslmode=disable"
   ```
4. Run tests:
   ```bash
   yarn test:ci
   ```

### Pre-push hook

Husky is configured to run `lint`, `typecheck`, `test:ci`, and `build` before every push. The hook automatically loads `.env` if it exists, so setting `DATABASE_URL` or `TEST_DATABASE_URL` there is enough.

Skip the hook if needed:

```bash
git push --no-verify
```

CI runs on every push/PR via `.github/workflows/ci.yml` using a PostGIS-enabled Postgres service container.

## Required environment variables

See `.env.example` for the full list. Required for the app to start:

- `DATABASE_URL`
- `ACCESS_TOKEN_SECRET` (min 32 chars)
- `REFRESH_TOKEN_SECRET` (min 32 chars)

Required once you build auth/files/notifications:

- `GOOGLE_CLIENT_ID` (backend verifies the ID token from the frontend)
- `R2_ENDPOINT`, `R2_REGION`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_PUBLIC_URL_PREFIX`
- `N8N_WEBHOOK_URL`, `N8N_WEBHOOK_SECRET`
- `SUPER_ADMIN_EMAIL_1`, `SUPER_ADMIN_EMAIL_2`

## Project structure

```
src/
  config/          env validation
  generated/prisma Prisma client (generated)
  lib/             shared helpers (prisma singleton)
  modules/         route handlers by domain
  plugins/         Fastify plugins
  routes/          route registration
  seed/            seed scripts
  server.ts        app entry point
```
