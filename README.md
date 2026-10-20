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
# Default dev DB (already created):
#   DATABASE_URL="postgresql://user:password@localhost:5432/tuition_dev"

# 4. Env
cp .env.example .env
# Edit .env and fill in real secrets (Google OAuth, R2, n8n, tokens, super-admin emails).

# 5. DB schema + constraints
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
| `yarn db:deploy` | Apply migrations in production |
| `yarn db:generate` | Regenerate Prisma client |
| `yarn db:seed` | Run seed script |
| `yarn db:studio` | Open Prisma Studio |
| `yarn lint` / `yarn lint:fix` | Biome |
| `yarn typecheck` | TypeScript |
| `yarn test` | Vitest (watch) |
| `yarn test:ci` | Vitest (single run) |

## Deploy to DigitalOcean App Platform

1. The App Platform app already includes a PostgreSQL database component — `DATABASE_URL` is injected automatically as `${db.DATABASE_URL}` in `.do/app.yaml`.
2. Create a Cloudflare R2 bucket and API token for file uploads.
3. Set up a Google OAuth client and add the production `GOOGLE_CLIENT_ID` to `.do/app.yaml`.
4. Fill in `.do/app.yaml` (GitHub repo name, R2 credentials, Google client ID, token secrets).
5. Install `doctl` and run:
   ```bash
   doctl apps create --spec .do/app.yaml
   ```
6. Run the seed job once after first deploy to insert the super-admin allowlist:
   ```bash
   doctl apps create-deployment <app-id> --spec .do/app.yaml --job migrate
   # or run `yarn db:seed` locally against the managed DB
   ```

## Testing

Tests use **Vitest** and hit a real PostgreSQL database.

1. Create a test DB (separate from `tuition_dev`):
   ```bash
   createdb tuition_test
   ```
2. Add `TEST_DATABASE_URL` to `.env` (or use the same `DATABASE_URL` for both).
3. Run tests:
   ```bash
   yarn test:ci
   ```

CI runs on every push/PR via `.github/workflows/ci.yml` using a Postgres service container.

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
