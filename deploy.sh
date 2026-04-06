#!/usr/bin/env bash
set -euo pipefail

# PF Deploy Script
# Pulls latest code, builds, copies static assets, and restarts the service.
# Usage: ./deploy.sh [--skip-pull] [--skip-build]

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
npm ci --prefer-offline

# 3. Build
if [ "$SKIP_BUILD" = false ]; then
  echo "==> Building Next.js (standalone)..."
  npm run build
else
  echo "==> Skipping build"
fi

# 4. Copy static assets into standalone output (required for standalone mode)
echo "==> Copying static assets to standalone directory..."
cp -r .next/static .next/standalone/.next/static

# 5. Copy public folder if it exists
if [ -d "public" ]; then
  echo "==> Copying public folder to standalone directory..."
  cp -r public .next/standalone/public
fi

# 6. Restart the service
echo "==> Restarting $SERVICE_NAME service..."
sudo systemctl restart "$SERVICE_NAME"

# 7. Wait and verify
sleep 3
if systemctl is-active --quiet "$SERVICE_NAME"; then
  echo "==> $SERVICE_NAME is running"
  echo "==> Deploy completed successfully at $(date)"
else
  echo "==> ERROR: $SERVICE_NAME failed to start!"
  sudo systemctl status "$SERVICE_NAME" --no-pager
  exit 1
fi
