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
#
# The backup directory is owner-only (0700) — pg_dump output contains every
# encrypted column's ciphertext plus the plaintext columns we have not
# migrated to encryption yet. Lock down permissions so a different local
# user on the box cannot read backups even if they slipped past directory
# ACLs.
#
# Encryption-at-rest (Open #5 in SECURITY_HANDOVER_2026-05-07.md): if a
# passphrase file is configured at $BACKUP_ENCRYPTION_KEY_FILE (default
# /etc/finlynq/backup-key), pipe pg_dump through gpg --symmetric AES-256
# and write a `.sql.gpg` instead. Operators decrypt during recovery via
# `scripts/restore-backup.sh`. If the passphrase file is absent, fall back
# to plaintext + warn — don't gate deploys on a key being present, since
# self-hosters who skip this step are still served by the 0700 dir + the
# new chmod 0400 on the encrypted file.
#
# Threat model addressed:
#  - A read-only break-in (e.g. log-aggregator-as-a-different-user reading
#    /opt/finlynq-backups due to a perms drift) cannot decrypt without the
#    passphrase file at /etc/finlynq/backup-key.
#  - The passphrase file itself is 0400 owned by root; only the deploy.sh
#    invocation (which already runs as root) can read it.
#
# Threat model NOT addressed:
#  - Full root compromise on the deploy host trivially reads both the key
#    and the backups. That's "ransomware paradise" no matter what we do
#    short of moving the key off-box (KMS, HSM); see follow-up.
echo "==> Backing up database..."
mkdir -p /opt/finlynq-backups
chmod 0700 /opt/finlynq-backups
BACKUP_TS=$(date +%Y%m%d_%H%M%S)
BACKUP_BASE="/opt/finlynq-backups/${SERVICE_NAME}_${BACKUP_TS}"
BACKUP_ENCRYPTION_KEY_FILE="${BACKUP_ENCRYPTION_KEY_FILE:-/etc/finlynq/backup-key}"

if [ -r "$BACKUP_ENCRYPTION_KEY_FILE" ] && command -v gpg >/dev/null 2>&1; then
  echo "==> Encrypting backup with key from $BACKUP_ENCRYPTION_KEY_FILE"
  pg_dump "$DB_URL" | \
    gpg --batch --symmetric --cipher-algo AES256 \
        --passphrase-file "$BACKUP_ENCRYPTION_KEY_FILE" \
        --no-tty --quiet \
        --output "${BACKUP_BASE}.sql.gpg"
  chmod 0400 "${BACKUP_BASE}.sql.gpg"
  echo "==> Backup complete (encrypted): ${BACKUP_BASE}.sql.gpg"
else
  if [ ! -r "$BACKUP_ENCRYPTION_KEY_FILE" ]; then
    echo "==> WARNING: backup-key file not readable at $BACKUP_ENCRYPTION_KEY_FILE — writing plaintext backup."
    echo "    To enable encryption-at-rest, follow the recovery playbook in scripts/restore-backup.sh"
  elif ! command -v gpg >/dev/null 2>&1; then
    echo "==> WARNING: gpg not on PATH — writing plaintext backup."
    echo "    Install gpg (apt-get install gnupg) to enable backup encryption."
  fi
  pg_dump "$DB_URL" > "${BACKUP_BASE}.sql"
  chmod 0400 "${BACKUP_BASE}.sql"
  echo "==> Backup complete (plaintext): ${BACKUP_BASE}.sql"
fi

# Retention. Default 14 days; override via BACKUP_RETENTION_DAYS in the
# deploy environment. Now matches encrypted (.sql.gpg), legacy plaintext
# (.sql), gzipped legacy (.sql.gz), and the older .sql.enc filename.
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
if [[ "$BACKUP_RETENTION_DAYS" =~ ^[0-9]+$ ]] && [ "$BACKUP_RETENTION_DAYS" -gt 0 ]; then
  echo "==> Pruning backups older than ${BACKUP_RETENTION_DAYS} day(s)..."
  find /opt/finlynq-backups -type f -mtime +"$BACKUP_RETENTION_DAYS" \
    \( -name "*.sql" -o -name "*.sql.gz" -o -name "*.sql.enc" -o -name "*.sql.gpg" \) -delete || true
fi

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
    # Filename gate: only [A-Za-z0-9_-]. This is the sole barrier against
    # SQL injection from a hostile migration filename — the SQL below
    # interpolates $version directly because psql's `:'ver'` parameter
    # substitution is a psql-script-only feature and is NOT processed by
    # the server when passed via -c. The regex permits no quote, semicolon,
    # backslash, or whitespace, so direct interpolation is safe.
    if ! [[ "$version" =~ ^[A-Za-z0-9_-]+$ ]]; then
      echo "==> ERROR: migration filename '$version' contains unsafe characters; rename to [A-Za-z0-9_-] only."
      exit 1
    fi
    exists=$(psql "$DB_URL" -tA -c "SELECT 1 FROM schema_migrations WHERE version = '$version';")
    if [ "$exists" = "1" ]; then continue; fi
    echo "==> Applying migration: $version"
    psql "$DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
      -f "$file" \
      -c "INSERT INTO schema_migrations (version) VALUES ('$version');"
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
  # Defensive chown opener (issue: pitfall-#1 in memory/finlynq-deploy-pitfalls.md
  # surfaced for the third time during the session-3 prod promotion). A previous
  # deploy that failed mid-flight left 132 root-owned files inside
  # .next/standalone/.next/static/ which blocked the `run_as rm -rf .next` here
  # because paperclip-agent doesn't own them. Reclaim ownership before the rm
  # so a half-failed deploy can recover on the next run instead of needing
  # manual `chown` recovery via SSH. `2>/dev/null || true` because the dir may
  # not exist on a fresh box.
  if [ -d .next ] && [ -n "$REPO_OWNER" ]; then
    sudo chown -R "$REPO_OWNER:$REPO_OWNER" .next 2>/dev/null || true
  fi
  # Atomic detach instead of in-place rm. The running service writes runtime
  # cache files into .next/standalone/.next/cache/fetch-cache/ on every
  # outbound HTTP fetch (FX rates, Yahoo prices, etc.). When `rm -rf .next`
  # ran against the live tree, new fetch-cache entries appeared mid-traversal
  # and `rm` failed with "Directory not empty" on the parent — partial-deleting
  # the build (server.js gone, dev returning 500 on every page) until the next
  # successful deploy. The fix: `mv` is atomic and the running service keeps
  # its open inodes through the rename, so the rm operates on a detached tree
  # that nobody is writing to. PID-suffixed name avoids collision if a second
  # deploy fires before the previous .next.old.* finished cleaning up.
  echo "==> Removing stale build output..."
  if [ -d .next ]; then
    OLD_NEXT=".next.old.$$"
    run_as "mv .next $OLD_NEXT"
    run_as "rm -rf $OLD_NEXT"
  fi
  # Belt-and-suspenders: clean any orphaned .next.old.* trees from a previous
  # deploy that died after the mv but before the rm (e.g. SSH dropout).
  run_as "rm -rf .next.old.* 2>/dev/null" || true
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
