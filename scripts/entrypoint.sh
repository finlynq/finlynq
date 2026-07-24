#!/bin/sh
set -e

echo "[entrypoint] Starting PF managed edition..."

# ── Wait for PostgreSQL to be ready ──────────────────────────────────────────
if [ -z "$DATABASE_URL" ]; then
  echo "[entrypoint] ERROR: DATABASE_URL is required (PostgreSQL-only build). Exiting."
  exit 1
fi

echo "[entrypoint] DATABASE_URL detected — PostgreSQL mode"

# Extract host and port from connection string for health check.
# Accepts BOTH schemes: postgres://user:pass@host:port/db and postgresql://...
# libpq treats them as synonyms and docker-compose.yml ships the `postgresql://`
# spelling. An earlier version anchored on `postgres://` only, so the `ql` broke
# the match, sed passed the string through untouched, and DB_HOST/DB_PORT each
# became the WHOLE connection string — the readiness probe could never connect
# and the container crash-looped on every published tag (GH #312, bug 1).
DB_HOST=$(echo "$DATABASE_URL" | sed -E 's|postgres(ql)?://[^@]+@([^:/]+).*|\2|')
DB_PORT=$(echo "$DATABASE_URL" | sed -E 's|postgres(ql)?://[^@]+@[^:]+:([0-9]+).*|\3|')
DB_PORT="${DB_PORT:-5432}"

# Fail loudly rather than looping 30x on a nonsense host: if substitution didn't
# happen, the "host" still contains the scheme separator.
case "$DB_HOST" in
  *://*|"")
    echo "[entrypoint] ERROR: could not parse a host out of DATABASE_URL."
    echo "[entrypoint]        Expected postgres://user:pass@host:port/db (or postgresql://)."
    echo "[entrypoint]        Parsed host was: '$DB_HOST'"
    exit 1
    ;;
esac
case "$DB_PORT" in
  *[!0-9]*|"")
    echo "[entrypoint] WARNING: could not parse a port out of DATABASE_URL; defaulting to 5432."
    DB_PORT=5432
    ;;
esac

echo "[entrypoint] Waiting for PostgreSQL at $DB_HOST:$DB_PORT..."
MAX_RETRIES=30
RETRY=0
until nc -z "$DB_HOST" "$DB_PORT" 2>/dev/null; do
  RETRY=$((RETRY + 1))
  if [ "$RETRY" -ge "$MAX_RETRIES" ]; then
    echo "[entrypoint] ERROR: PostgreSQL did not become ready in time. Exiting."
    exit 1
  fi
  echo "[entrypoint] PostgreSQL not ready — retrying ($RETRY/$MAX_RETRIES)..."
  sleep 2
done
echo "[entrypoint] PostgreSQL is ready."

# Run database migrations.
#
# This used to inline a `require('drizzle-orm/node-postgres')`, which could never
# resolve: Next's standalone output compiles drizzle-orm into the server bundle
# instead of emitting it as a package, so the module was absent from the image
# entirely and `set -e` killed the container here (GH #312, bug 2). The runner
# below uses `pg` only, which IS emitted (it's in `serverExternalPackages`).
#
# It also applies scripts/baseline/0001_schema_baseline.sql on an empty database
# before the migration chain — the chain alone cannot build the schema from zero
# (GH #312, bugs 3 and 4).
echo "[entrypoint] Running database migrations..."
node scripts/run-migrations.mjs
echo "[entrypoint] Migrations complete."

# ── Launch the app ────────────────────────────────────────────────────────────
echo "[entrypoint] Starting Next.js server..."
exec "$@"
