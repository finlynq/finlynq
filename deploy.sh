#!/usr/bin/env bash
set -euo pipefail

# PF Deploy Script
# Pulls latest code, builds, and restarts the service.
# Usage: ./deploy.sh [--skip-pull] [--skip-build]
#
# Auto-detects target env from where the script lives:
#   /home/projects/pf     -> service "pf"     (production)
#   /home/projects/pf-dev -> service "pf-dev"
# Override either with APP_DIR=... SERVICE_NAME=... env vars before invoking.
# (Staging environment was deprecated 2026-05-03.)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-$SCRIPT_DIR}"
case "$APP_DIR" in
  *pf-dev) SERVICE_NAME="${SERVICE_NAME:-pf-dev}" ;;
  *)       SERVICE_NAME="${SERVICE_NAME:-pf}" ;;
esac

SKIP_PULL=false
SKIP_BUILD=false

for arg in "$@"; do
  case $arg in
    --skip-pull)  SKIP_PULL=true ;;
    --skip-build) SKIP_BUILD=true ;;
    *) echo "Unknown option: $arg"; exit 1 ;;
  esac
done

cd "$APP_DIR"

echo "==> PF Deploy started at $(date)"

# Determine repo owner to run git/npm as the correct user
REPO_OWNER=$(stat -c '%U' "$APP_DIR/.git" 2>/dev/null || echo "")
run_as() {
  if [ -n "$REPO_OWNER" ] && [ "$REPO_OWNER" != "$(whoami)" ]; then
    sudo -u "$REPO_OWNER" bash -c "cd $APP_DIR && $*"
  else
    bash -c "cd $APP_DIR && $*"
  fi
}

# 1. Pull latest code
# Hardened: a previous ad-hoc edit on the server left the working tree dirty,
# which caused `git pull --ff-only` to abort and the deploy to silently stop
# before restarting the service. We now stash any stray local changes (keeping
# a timestamped backup as a safety net) and fast-forward by resetting to
# origin's tip, so no future dirty-tree state can block a deploy.
OLD_HASH="$(sha256sum "$0" 2>/dev/null | cut -d' ' -f1 || echo "")"
if [ "$SKIP_PULL" = false ]; then
  echo "==> Fetching latest code..."
  run_as "git fetch --prune origin"

  STASH_TAG="pre-deploy-$(date +%Y%m%d_%H%M%S)"
  if ! run_as "git diff --quiet HEAD" || ! run_as "git diff --quiet --cached HEAD"; then
    echo "==> Working tree is dirty — stashing local changes as '$STASH_TAG' before resetting"
    run_as "git stash push --include-untracked -m '$STASH_TAG'" || true
  fi

  BRANCH="$(run_as 'git rev-parse --abbrev-ref HEAD')"
  echo "==> Resetting $BRANCH to origin/$BRANCH"
  run_as "git reset --hard origin/$BRANCH"

  # Bash reads scripts incrementally by byte offset. If git just rewrote
  # this file, the rest of the deploy would read garbage from a different
  # byte position in the new file. Re-exec ourselves so the rest of the
  # deploy uses the freshly-pulled script. Pass --skip-pull to avoid loops;
  # the PF_DEPLOY_REEXECED guard is a belt-and-suspenders second loop check.
  if [ -z "${PF_DEPLOY_REEXECED:-}" ]; then
    NEW_HASH="$(sha256sum "$0" 2>/dev/null | cut -d' ' -f1 || echo "")"
    if [ -n "$OLD_HASH" ] && [ -n "$NEW_HASH" ] && [ "$OLD_HASH" != "$NEW_HASH" ]; then
      echo "==> deploy.sh changed on disk — re-executing with the new version"
      export PF_DEPLOY_REEXECED=1
      EXTRA_ARGS=()
      [ "$SKIP_BUILD" = true ] && EXTRA_ARGS+=("--skip-build")
      exec "$0" --skip-pull "${EXTRA_ARGS[@]}"
    fi
  fi
else
  echo "==> Skipping git pull"
fi

# 2. Install dependencies
echo "==> Installing dependencies..."
run_as "npm install --prefer-offline"

# 2.5. Resolve DATABASE_URL once for backup + migrations.
#
# History (issue #5): a previous `npm run db:push` step here silently no-op'd
# because DATABASE_URL set on the systemd unit didn't survive the `sudo -u`
# hop in `run_as`. We side-step that by reading DATABASE_URL straight out
# of the systemd unit's EnvironmentFile and invoking psql/pg_dump from the
# deploy user (no sudo hop).
get_database_url() {
  if [ -n "${DATABASE_URL:-}" ]; then echo "$DATABASE_URL"; return 0; fi
  if [ -n "${PF_DATABASE_URL:-}" ]; then echo "$PF_DATABASE_URL"; return 0; fi
  local files
  files=$(sudo systemctl show "$SERVICE_NAME" -p EnvironmentFiles --value 2>/dev/null || true)
  if [ -n "$files" ]; then
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      local path="${line%% *}"
      if [ -r "$path" ]; then
        local url
        url=$(grep -E '^(PF_)?DATABASE_URL=' "$path" 2>/dev/null | tail -1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//')
        if [ -n "$url" ]; then echo "$url"; return 0; fi
      fi
    done <<< "$files"
  fi
  local inline
  inline=$(sudo systemctl show "$SERVICE_NAME" -p Environment --value 2>/dev/null | tr ' ' '\n' | grep -E '^(PF_)?DATABASE_URL=' | tail -1 | cut -d= -f2- || true)
  if [ -n "$inline" ]; then echo "$inline"; return 0; fi
  return 1
}

DB_URL=$(get_database_url || true)
if [ -z "$DB_URL" ]; then
  echo "==> ERROR: could not determine DATABASE_URL for $SERVICE_NAME."
  echo "    Set DATABASE_URL in the deploy shell, or ensure the systemd unit's"
  echo "    EnvironmentFile (e.g. /etc/finlynq/finlynq.env) defines it."
  exit 1
fi

# 2.6. Backup database before any schema mutation.
echo "==> Backing up database..."
mkdir -p /opt/finlynq-backups
pg_dump "$DB_URL" > "/opt/finlynq-backups/${SERVICE_NAME}_$(date +%Y%m%d_%H%M%S).sql"
echo "==> Backup complete"

# 2.7. Schema migrations — automated, tracked, idempotent.
#
# Every file in scripts/migrations/*.sql is run exactly once per env.
# Bookkeeping lives in `schema_migrations(version PK, applied_at)`. Each
# migration is applied inside a single transaction together with the
# bookkeeping INSERT, so a partial failure rolls everything back and the
# next deploy retries cleanly. Run order is backup → migrations → build
# → restart, so a failed migration leaves the OLD service still running
# on the OLD schema with a known-good DB snapshot taken seconds earlier.
#
# Migration files MUST NOT contain their own BEGIN/COMMIT — the runner
# wraps the file body + the bookkeeping INSERT in a single transaction
# via `psql --single-transaction`, and an inner COMMIT would close the
# outer txn early and decouple the INSERT from the schema change.
echo "==> Running schema migrations..."
if ! command -v psql >/dev/null 2>&1; then
  echo "==> ERROR: psql not on PATH; install postgresql-client and re-run."
  exit 1
fi
MIGRATIONS_DIR="$APP_DIR/scripts/migrations"
psql "$DB_URL" -v ON_ERROR_STOP=1 -q -c "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW());"
APPLIED_COUNT=0
if [ -d "$MIGRATIONS_DIR" ]; then
  shopt -s nullglob
  for file in "$MIGRATIONS_DIR"/*.sql; do
    version="$(basename "$file" .sql)"
    # Filename gate: only [A-Za-z0-9_-]. Defense-in-depth — the SQL below
    # uses psql's `:'ver'` parameter-binding to quote the value, so a
    # malicious filename couldn't escape the literal even without this
    # check. Keeping the regex anyway to fail fast on obviously-wrong files.
    if ! [[ "$version" =~ ^[A-Za-z0-9_-]+$ ]]; then
      echo "==> ERROR: migration filename '$version' contains unsafe characters; rename to [A-Za-z0-9_-] only."
      exit 1
    fi
    exists=$(psql "$DB_URL" -tA -v ver="$version" -c "SELECT 1 FROM schema_migrations WHERE version = :'ver';")
    if [ "$exists" = "1" ]; then continue; fi
    echo "==> Applying migration: $version"
    psql "$DB_URL" -v ON_ERROR_STOP=1 -v ver="$version" --single-transaction \
      -f "$file" \
      -c "INSERT INTO schema_migrations (version) VALUES (:'ver');"
    APPLIED_COUNT=$((APPLIED_COUNT + 1))
  done
  shopt -u nullglob
fi
if [ "$APPLIED_COUNT" -eq 0 ]; then
  echo "==> No new migrations to apply."
else
  echo "==> Applied $APPLIED_COUNT migration(s)."
fi

# 3. Build
if [ "$SKIP_BUILD" = false ]; then
  echo "==> Removing stale build output..."
  run_as "rm -rf .next"
  echo "==> Building Next.js..."
  run_as "npm run build"
else
  echo "==> Skipping build"
fi

# 4. Copy static assets + public into standalone bundle.
# Next.js `output: "standalone"` produces .next/standalone/server.js but
# deliberately omits .next/static and public/ — they must be copied in or the
# server 404s every chunk/font/favicon. DEPLOY.md has documented this since
# day one; the step was previously missing here, which made every deploy ship
# a broken /_next/static/* tree until someone manually rsync'd it on the box.
if [ "$SKIP_BUILD" = false ]; then
  echo "==> Copying .next/static + public/ into standalone bundle..."
  run_as "rm -rf .next/standalone/.next/static .next/standalone/public"
  run_as "cp -r .next/static .next/standalone/.next/static"
  run_as "cp -r public .next/standalone/public"
fi

# 5. Fix ownership so the service user can read all build artifacts
chown -R paperclip-agent:paperclip-agent .next || true

# 6. Restart the service
# Stamp a fresh DEPLOY_GENERATION so the new process issues JWTs with a new
# `gen` claim. Existing JWTs become invalid on verify and the client gets a
# 401 with `{ code: "deploy-reauth-required" }` so the UI can show a tailored
# re-login prompt. Written as a drop-in so systemd picks it up on restart
# without editing the unit file on every deploy.
DEPLOY_GEN="$(date +%s)"
echo "==> Stamping DEPLOY_GENERATION=$DEPLOY_GEN"
sudo mkdir -p "/etc/systemd/system/${SERVICE_NAME}.service.d"
echo -e "[Service]\nEnvironment=DEPLOY_GENERATION=${DEPLOY_GEN}" | \
  sudo tee "/etc/systemd/system/${SERVICE_NAME}.service.d/deploy-generation.conf" > /dev/null
sudo systemctl daemon-reload

echo "==> Restarting $SERVICE_NAME service..."
sudo systemctl restart "$SERVICE_NAME"

# 7. Wait and verify service started
sleep 3
if ! systemctl is-active --quiet "$SERVICE_NAME"; then
  echo "==> ERROR: $SERVICE_NAME failed to start!"
  sudo systemctl status "$SERVICE_NAME" --no-pager
  exit 1
fi
echo "==> $SERVICE_NAME is running"

# 8. Health check — confirm the app is serving requests
echo "==> Running health check..."
sleep 2
APP_PORT=$(sudo systemctl show "$SERVICE_NAME" -p Environment --value 2>/dev/null | tr ' ' '\n' | grep '^PORT=' | cut -d= -f2 || echo "3000")
HEALTH_URL="http://localhost:${APP_PORT}/api/healthz"
if curl -fs --max-time 10 "$HEALTH_URL" -o /dev/null; then
  echo "==> Health check passed ($HEALTH_URL)"
else
  echo "==> Warning: health check at $HEALTH_URL did not respond (app may still be warming up)"
fi
echo "==> Deploy completed successfully at $(date)"
