#!/bin/sh
set -e

echo "[entrypoint] Starting PF managed edition..."

# ── Wait for PostgreSQL to be ready ──────────────────────────────────────────
if [ -z "$DATABASE_URL" ]; then
  echo "[entrypoint] ERROR: DATABASE_URL is required (PostgreSQL-only build). Exiting."
  exit 1
fi

echo "[entrypoint] DATABASE_URL detected — PostgreSQL mode"

# Extract host and port from connection string for health check
# Expected format: postgres://user:pass@host:port/db
DB_HOST=$(echo "$DATABASE_URL" | sed -E 's|postgres://[^@]+@([^:/]+).*|\1|')
DB_PORT=$(echo "$DATABASE_URL" | sed -E 's|postgres://[^@]+@[^:]+:([0-9]+).*|\1|')
DB_PORT="${DB_PORT:-5432}"

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

# Run database migrations via Node.js (uses the PostgresAdapter)
echo "[entrypoint] Running database migrations..."
node -e "
  const { drizzle } = require('drizzle-orm/node-postgres');
  const { migrate } = require('drizzle-orm/node-postgres/migrator');
  const { Pool } = require('pg');

  async function runMigrations() {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder: './drizzle-pg' });
    await pool.end();
    console.log('[entrypoint] Migrations complete.');
  }

  runMigrations().catch(err => {
    console.error('[entrypoint] Migration failed:', err.message);
    process.exit(1);
  });
"

# ── Launch the app ────────────────────────────────────────────────────────────
echo "[entrypoint] Starting Next.js server..."
exec "$@"
