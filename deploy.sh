#!/usr/bin/env bash
set -euo pipefail

# PF Deploy Script
# Pulls latest code, builds, and restarts the service.
# Usage: ./deploy.sh [--skip-pull] [--skip-build]

APP_DIR="/home/projects/pf"
SERVICE_NAME="pf"

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
else
  echo "==> Skipping git pull"
fi

# 2. Install dependencies
echo "==> Installing dependencies..."
run_as "npm install --prefer-offline"

# 2.5. Backup database before deploy
echo "==> Backing up database..."
if [ -n "${DATABASE_URL:-}" ]; then
  mkdir -p /opt/finlynq-backups
  pg_dump "$DATABASE_URL" > "/opt/finlynq-backups/prod_$(date +%Y%m%d_%H%M%S).sql"
  echo "==> Backup complete"
else
  echo "==> Warning: DATABASE_URL not set, skipping backup"
fi

# 2.7. Run database migrations
echo "==> Running database migrations..."
run_as "npm run db:push"
echo "==> Migrations complete"

# 3. Build
if [ "$SKIP_BUILD" = false ]; then
  echo "==> Removing stale build output..."
  run_as "rm -rf .next"
  echo "==> Building Next.js..."
  run_as "npm run build"
else
  echo "==> Skipping build"
fi

# 4. Fix ownership so the service user can read all build artifacts
chown -R paperclip-agent:paperclip-agent .next || true

# 5. Restart the service
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

# 6. Wait and verify service started
sleep 3
if ! systemctl is-active --quiet "$SERVICE_NAME"; then
  echo "==> ERROR: $SERVICE_NAME failed to start!"
  sudo systemctl status "$SERVICE_NAME" --no-pager
  exit 1
fi
echo "==> $SERVICE_NAME is running"

# 7. Health check — confirm the app is serving requests
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
