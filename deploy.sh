#!/usr/bin/env bash
set -euo pipefail

# PF Deploy Script
# Pulls latest code, builds, copies static assets, and restarts the service.
# Usage: ./deploy.sh [--skip-pull] [--skip-build]
#
# Static asset copy happens in TWO places for belt-and-suspenders reliability:
#   1. package.json "postbuild" script — fires automatically after every npm run build
#   2. Steps 4-5 below — explicit copy with error checking as a final safety net

APP_DIR="/home/paperclip-agent/projects/pf"
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

# 1. Pull latest code
if [ "$SKIP_PULL" = false ]; then
  echo "==> Pulling latest code..."
  git pull --ff-only
else
  echo "==> Skipping git pull"
fi

# 2. Install dependencies
echo "==> Installing dependencies..."
npm install --prefer-offline

# 3. Build (postbuild in package.json copies static assets automatically)
if [ "$SKIP_BUILD" = false ]; then
  echo "==> Removing stale build output..."
  rm -rf .next
  echo "==> Building Next.js (standalone)..."
  npm run build
  # postbuild script runs automatically here: cp .next/static + public → standalone
else
  echo "==> Skipping build"
fi

# 4. Explicit static asset copy (safety net — idempotent, handles --skip-build case)
echo "==> Verifying static assets in standalone directory..."
if [ ! -d ".next/standalone" ]; then
  echo "==> ERROR: .next/standalone directory not found. Build may have failed."
  exit 1
fi

cp -r .next/static .next/standalone/.next/static || {
  echo "==> ERROR: Failed to copy .next/static to standalone"
  exit 1
}
echo "==> .next/static copied OK ($(find .next/standalone/.next/static -type f | wc -l) files)"

# 5. Copy public folder
if [ -d "public" ]; then
  cp -r public .next/standalone/public || {
    echo "==> ERROR: Failed to copy public to standalone"
    exit 1
  }
  echo "==> public/ copied OK ($(find .next/standalone/public -type f | wc -l) files)"
fi

# 6. Copy .env into standalone (needed for runtime env vars)
if [ -f ".env" ]; then
  cp .env .next/standalone/.env || {
    echo "==> ERROR: Failed to copy .env to standalone"
    exit 1
  }
  echo "==> .env copied OK"
fi

# 7. Fix ownership so the service user can read all build artifacts
chown -R paperclip-agent:paperclip-agent .next || true

# 8. Restart the service
echo "==> Restarting $SERVICE_NAME service..."
sudo systemctl restart "$SERVICE_NAME"

# 9. Wait and verify
sleep 3
if systemctl is-active --quiet "$SERVICE_NAME"; then
  echo "==> $SERVICE_NAME is running"
  echo "==> Deploy completed successfully at $(date)"
else
  echo "==> ERROR: $SERVICE_NAME failed to start!"
  sudo systemctl status "$SERVICE_NAME" --no-pager
  exit 1
fi
