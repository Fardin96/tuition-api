#!/usr/bin/env bash
set -euo pipefail

# Production migration runner.
# Used by DigitalOcean App Platform PRE_DEPLOY job.
# Locally you can run: yarn db:deploy

export PATH="$(pwd)/node_modules/.bin:$PATH"

npx prisma db execute --file prisma/recover-failed-migrations.sql
npx prisma migrate deploy
