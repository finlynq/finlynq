#!/usr/bin/env bash
# Install the Finlynq demo-reset systemd timer on a deployment host.
# Run from the repo root on the server:
#   sudo ./deploy/install-demo-reset.sh
#
# Assumes the environment-specific .env (containing DATABASE_URL) is at
# /etc/finlynq/finlynq.env. Adjust the service file's EnvironmentFile path
# if you place it elsewhere.

set -euo pipefail

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
UNIT_DIR="/etc/systemd/system"

install -m 0644 "$SRC_DIR/finlynq-demo-reset.service" "$UNIT_DIR/finlynq-demo-reset.service"
install -m 0644 "$SRC_DIR/finlynq-demo-reset.timer"   "$UNIT_DIR/finlynq-demo-reset.timer"

systemctl daemon-reload
systemctl enable --now finlynq-demo-reset.timer

echo "Installed. Inspect schedule with:"
echo "  systemctl status finlynq-demo-reset.timer"
echo "  systemctl list-timers finlynq-demo-reset.timer"
echo
echo "Trigger an immediate run with:"
echo "  sudo systemctl start finlynq-demo-reset.service"
