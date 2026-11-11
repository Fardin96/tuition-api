#!/usr/bin/env bash
set -euo pipefail

# Rehearses pending migrations on a restored copy of prod. Read-only on prod.
# Usage: bash scripts/migrate-safe.sh [--drill] [--keep] '<prod direct url, port 25060>'

unset DATABASE_URL DATABASE_POOL_URL TEST_DATABASE_URL
export PGCONNECT_TIMEOUT=10
cd "$(dirname "$0")/.."
mkdir -p .backups

mode=full keep=0 PROD=""
for a in "$@"; do
  case "$a" in
    --drill) mode=drill ;;
    --keep) keep=1 ;;
    *) PROD="$a" ;;
  esac
done
[ -n "$PROD" ] || { echo "usage: bash scripts/migrate-safe.sh [--drill] [--keep] '<prod direct url>'" >&2; exit 1; }

LOCAL_PG="${LOCAL_PG:-postgresql://user:password@localhost:5432}"
PROTECTED="tutor_name_trgm|notification_due_idx|tutor_location_geog_gist_idx|student_location_geog_gist_idx|tutor_zone_center_gix|tutor_requirement_one_default|zlr_one_pending_per_tutor|fee_payment_gateway_ref_uniq"
COUNTS="select table_name || '|' || (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I', table_name), false, true, '')))[1]::text from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' and table_name <> '_prisma_migrations' order by table_name"
# Same pipeline as .husky/pre-push. Keep them in sync.
migration_hash() { find prisma/migrations -name migration.sql | LC_ALL=C sort | xargs shasum -a 256 | shasum -a 256 | cut -d' ' -f1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
warnings=0 SCRATCH_DB="" SCRATCH=""

q() { psql "$1" -v ON_ERROR_STOP=1 -Atc "$2"; }
fail() {
  echo "FAIL: $1"
  [ -z "$SCRATCH_DB" ] || echo "scratch DB kept: $SCRATCH (drop it with: psql '$LOCAL_PG/postgres' -c 'DROP DATABASE $SCRATCH_DB')"
  exit 1
}
ok() { echo "ok   $1"; }
warn() { echo "WARN: $1"; warnings=$((warnings + 1)); }
step() { echo; echo "== $1"; }
drop_scratch() { [ "$keep" = 1 ] && echo "keeping $SCRATCH_DB" || q "$LOCAL_PG/postgres" "DROP DATABASE IF EXISTS $SCRATCH_DB"; }
# lost BEFORE AFTER: lists tables whose row count dropped or vanished (count files: table|n)
lost() {
  awk -F'|' 'NR == FNR { want[$1] = $2; next } { got[$1] = $2 }
    END { for (t in want) if (!(t in got) || got[t] + 0 < want[t] + 0) { print "  " t ": " want[t] " -> " (t in got ? got[t] : "missing"); bad = 1 } exit bad }' "$1" "$2"
}
# scan FILE HITS REASON: prints a warning with the matching lines
scan() {
  [ -n "$2" ] || return 0
  echo "WARN: $3"; echo "$2" | sed "s|^|  $1:|"; warnings=$((warnings + 1))
}
check_failed() {
  local rows; rows=$(q "$1" "select migration_name || ': ' || coalesce(logs, '') from _prisma_migrations where finished_at is null and rolled_back_at is null")
  [ -z "$rows" ] && return 0
  echo "$rows"
  fail "a migration is failed or still running on prod. Fix the data, then: DATABASE_URL='<url>' npx prisma migrate resolve --rolled-back <name>, rerun"
}

step "0. guards"
case "$PROD" in *:25061*|*pgbouncer*) fail "use the direct URL (port 25060), not the pool" ;; esac
for t in psql pg_dump pg_restore shasum npx; do command -v "$t" >/dev/null || fail "$t not on PATH"; done
db=$(q "$PROD" 'select current_database()') || fail "cannot connect to prod. Add your IP to DO Trusted Sources; quote the URL in single quotes"
server=$(q "$PROD" 'show server_version_num')
client=$(pg_dump --version | grep -oE '[0-9]+' | head -1)
[ "$client" -ge $((server / 10000)) ] || fail "pg_dump $client is older than server $((server / 10000)) (hint: brew install libpq, put its bin first in PATH)"
ok "target database: $db (server $((server / 10000)), pg_dump $client)"

if [ "$mode" = full ]; then
  step "1. prod migration state"
  check_failed "$PROD"
  q "$PROD" "select migration_name || '|' || checksum from _prisma_migrations where finished_at is not null and rolled_back_at is null" > "$work/applied"
  while IFS='|' read -r n sum; do
    f="prisma/migrations/$n/migration.sql"
    # Prisma only warns about this; prod has a renamed 20261022153000_location_postgis.
    [ -f "$f" ] || { warn "applied on prod but missing locally: $n (fine if renamed on purpose, else pull the branch that has it)"; continue; }
    [ "$(shasum -a 256 "$f" | cut -d' ' -f1)" = "$sum" ] || fail "edited after apply: $n (never edit an applied migration, add a new one)"
  done < "$work/applied"

  applied_names=$(cut -d'|' -f1 "$work/applied")
  pending=()
  for d in prisma/migrations/*/; do
    n=$(basename "$d")
    [ -f "$d/migration.sql" ] || continue
    grep -qx "$n" <<< "$applied_names" || pending+=("$n")
  done
  if [ ${#pending[@]} -eq 0 ]; then
    ok "nothing pending"
    migration_hash > .backups/.rehearsed
    exit 0
  fi
  ok "pending: ${pending[*]}"

  step "2. lint pending SQL"
  bad=0
  for n in "${pending[@]}"; do
    f="prisma/migrations/$n/migration.sql"
    # A drop is fine when the same file recreates the index (03 does this for fee_payment_gateway_ref_uniq).
    for idx in $(grep -ioE "DROP INDEX[^;]*($PROTECTED)" "$f" | grep -oE "$PROTECTED" || true); do
      grep -qiE "CREATE (UNIQUE )?INDEX[^;]*$idx" "$f" || { echo "FAIL: protected index dropped: $f: $idx"; bad=1; }
    done
    scan "$f" "$(grep -inE 'DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM' "$f")" "data loss (DROP / TRUNCATE / DELETE)"
    scan "$f" "$(grep -inE 'ALTER COLUMN .* TYPE' "$f")" "table rewrite (ALTER COLUMN TYPE)"
    scan "$f" "$(grep -inE 'SET NOT NULL' "$f")" "SET NOT NULL scans the whole table under lock"
    scan "$f" "$(grep -inE 'ADD CONSTRAINT.*(CHECK|FOREIGN KEY)' "$f" | grep -viE 'NOT VALID')" "constraint checks existing rows; add NOT VALID, then VALIDATE"
    scan "$f" "$(grep -inE 'CREATE (UNIQUE )?INDEX' "$f" | grep -viE 'CONCURRENTLY')" "index build blocks writes; use CONCURRENTLY"
    if grep -qi 'ALTER TABLE' "$f" && ! grep -qi 'lock_timeout' "$f"; then
      scan "$f" "$(grep -inE 'ALTER TABLE' "$f")" "ALTER TABLE without lock_timeout (can queue behind a lock)"
    fi
  done
  [ "$bad" = 0 ] || fail "protected index dropped. Never accept DROP INDEX for protected indexes (AGENTS.md)"
fi

step "3. backup prod"
# Counted just before the dump so the live app's writes after it cannot fail step 5.
q "$PROD" "$COUNTS" > "$work/prod"
DUMP=".backups/prod-$(date +%F-%H%M).dump"
pg_dump "$PROD" --format=custom --no-acl --no-owner -f "$DUMP"
find .backups -name '*.dump' -mtime +14 -delete
ok "dump $DUMP (dumps contain PII, dumps older than 14 days are deleted)"

step "4. restore into scratch"
SCRATCH_DB="tuition_rehearsal_$(date +%s)"
SCRATCH="$LOCAL_PG/$SCRATCH_DB"
q "$LOCAL_PG/postgres" "CREATE DATABASE $SCRATCH_DB"
q "$SCRATCH" "CREATE EXTENSION IF NOT EXISTS postgis"
pg_restore --no-acl --no-owner -d "$SCRATCH" "$DUMP" 2> "$work/restore.log" || true
ok "restored into $SCRATCH_DB (step 5 checks the result)"

step "5. row counts"
q "$SCRATCH" "$COUNTS" > "$work/restored"
if ! lost "$work/prod" "$work/restored"; then tail -5 "$work/restore.log"; fail "restore incomplete"; fi
ok "no table short of prod's row count"
if [ "$mode" = drill ]; then
  drop_scratch
  echo "restore drill passed"
  exit 0
fi

step "6. migrate the copy"
SECONDS=0
if ! DATABASE_URL="$SCRATCH" npx prisma migrate deploy; then
  q "$SCRATCH" "select migration_name || ': ' || coalesce(logs, '') from _prisma_migrations where finished_at is null and rolled_back_at is null" || true
  fail "migration failed on the copy"
fi
took=$SECONDS
[ "$took" -le 60 ] || warn "migrations took ${took}s (long locks likely in prod)"
ok "migrated in ${took}s"

step "7. verify the copy"
DATABASE_URL="$SCRATCH" npx prisma migrate status || fail "migrate status not clean on the copy"
q "$SCRATCH" "$COUNTS" > "$work/after"
lost "$work/restored" "$work/after" || fail "rows lost after migrate (see above)"
ok "no table lost rows"

step "8. re-check prod"
check_failed "$PROD"
ok "no stuck migration on prod"

step "9. result"
if [ "$warnings" -gt 0 ]; then
  read -r -p "Continue? [y/N] " ans || ans=""
  if [ "$ans" != y ]; then drop_scratch; echo "Aborted with $warnings warning(s). Nothing marked as rehearsed."; exit 1; fi
fi
migration_hash > .backups/.rehearsed
drop_scratch
echo "SAFE TO PUSH. dump: $DUMP"
