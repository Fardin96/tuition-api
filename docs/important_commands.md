# Important Commands Reference

Commands that are easy to forget but critical for this project.

---

## Database Backups (pg_dump)

### Using full path to pg_dump (Homebrew libpq on macOS)
```bash
/opt/homebrew/Cellar/libpq/18.6_1/bin/pg_dump "DB_CONNECTION_STRING" \
  --format=custom \
  --no-acl \
  --no-owner \
  -f "/Volumes/HomeX/projects/products/tuition-api/.backups/backup-$(date +%F).dump"
```

### Using pg_dump from PATH (if libpq is linked or in PATH)
```bash
pg_dump "DB_CONNECTION_STRING" \
  --format=custom \
  --no-acl \
  --no-owner \
  -f "/Volumes/HomeX/projects/products/tuition-api/.backups/backup-$(date +%F).dump"
```

### Backup with explicit host/port/database/user (useful for managed DBs)
```bash
pg_dump \
  -h "DB_HOST" \
  -p "5432" \
  -U "DB_USER" \
  -d "DB_NAME" \
  --format=custom \
  --no-acl \
  --no-owner \
  -f "/Volumes/HomeX/projects/products/tuition-api/.backups/backup-$(date +%F).dump"
```

### Restore from custom-format dump
```bash
pg_restore \
  -h "DB_HOST" \
  -p "5432" \
  -U "DB_USER" \
  -d "DB_NAME" \
  --no-acl \
  --no-owner \
  "/Volumes/HomeX/projects/products/tuition-api/.backups/backup-2026-11-07.dump"
```

### Backup with schema-only (no data)
```bash
pg_dump "DB_CONNECTION_STRING" \
  --format=custom \
  --no-acl \
  --no-owner \
  --schema-only \
  -f "/Volumes/HomeX/projects/products/tuition-api/.backups/schema-$(date +%F).dump"
```

### Backup with data-only (no schema)
```bash
pg_dump "DB_CONNECTION_STRING" \
  --format=custom \
  --no-acl \
  --no-owner \
  --data-only \
  -f "/Volumes/HomeX/projects/products/tuition-api/.backups/data-$(date +%F).dump"
```

---

## Database Migrations (Prisma)

### Create new empty migration
```bash
yarn db:migrate:create
# or
npx prisma migrate dev --create-only
```

### Apply migrations in development
```bash
yarn db:migrate
# or
npx prisma migrate dev
```

### Apply migrations in production (via script)
```bash
bash scripts/migrate.sh
```

### Apply migrations locally/manually
```bash
npx prisma migrate deploy
```

### Regenerate Prisma Client
```bash
yarn db:generate
# or
npx prisma generate
```

### Open Prisma Studio
```bash
yarn db:studio
# or
npx prisma studio
```

### Enable PostGIS extension (required before migrations)
```bash
psql "$DATABASE_URL" -c "CREATE EXTENSION IF NOT EXISTS postgis;"
```

---

## Development Commands

### Start dev server
```bash
yarn dev
```

### Build for production
```bash
yarn build
```

### Run production build
```bash
yarn start
```

### Lint (check + fix)
```bash
yarn lint
yarn lint:fix
```

### Format code
```bash
yarn format
```

### Typecheck
```bash
yarn typecheck
```

### Run tests
```bash
yarn test          # watch mode
yarn test:ci       # single run (CI mode)
```

### Run weekly location-expiry cron manually
```bash
yarn cron:weekly-location-expiry
```

---

## DigitalOcean App Platform

### Deploy app
```bash
doctl apps create --spec .do/app.yaml
```

### View app logs
```bash
doctl apps logs <APP_ID>
```

### Run migrations manually against managed DB
```bash
DATABASE_URL="<direct-db-url>" npx prisma migrate deploy
```

---

## Testing Database Setup

### Create test database
```bash
createdb tuition_test
```

### Enable PostGIS on test database
```bash
psql -d tuition_test -c "CREATE EXTENSION IF NOT EXISTS postgis;"
```

---

## Environment Files

### Copy example env
```bash
cp .env.example .env
```

### Required for app start
- `DATABASE_URL`
- `ACCESS_TOKEN_SECRET` (min 32 chars)
- `REFRESH_TOKEN_SECRET` (min 32 chars)

### Required for full features
- `GOOGLE_CLIENT_ID`
- `R2_ENDPOINT`, `R2_REGION`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_PUBLIC_URL_PREFIX`
- `N8N_WEBHOOK_URL`, `N8N_WEBHOOK_SECRET`
- `SUPER_ADMIN_EMAIL_1`, `SUPER_ADMIN_EMAIL_2`

---

## Git / Pre-push Hook

### Skip pre-push hook
```bash
git push --no-verify
```

### Pre-push runs (in order)
1. `lint`
2. `typecheck`
3. `test:ci`
4. `build`