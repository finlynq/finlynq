#!/bin/sh
# Automated PostgreSQL backup script for PF managed edition.
#
# Usage (Docker):
#   docker compose --profile backup run --rm backup
#
# Usage (cron — run daily at 2 AM):
#   0 2 * * * docker compose --profile backup run --rm backup
#
# Environment variables (all inherited from docker-compose or .env):
#   PGPASSWORD          — PostgreSQL password (required)
#   POSTGRES_USER       — PostgreSQL user (default: pf)
#   POSTGRES_DB         — PostgreSQL database name (default: pf)
#   BACKUP_RETENTION_DAYS — local backup retention in days (default: 7)
#   S3_BUCKET           — S3 bucket name for offsite storage (optional)
#   AWS_ACCESS_KEY_ID   — AWS credentials for S3 upload (optional)
#   AWS_SECRET_ACCESS_KEY
#   AWS_DEFAULT_REGION
#   AWS_ENDPOINT_URL    — for non-AWS S3-compatible endpoints

set -e

POSTGRES_USER="${POSTGRES_USER:-pf}"
POSTGRES_DB="${POSTGRES_DB:-pf}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-7}"
BACKUP_DIR="/backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/pf_${POSTGRES_DB}_${TIMESTAMP}.sql.gz"

echo "[backup] Starting PostgreSQL backup of '$POSTGRES_DB' at $(date -Iseconds)"

# ── Create backup ─────────────────────────────────────────────────────────────
pg_dump \
  -h postgres \
  -U "$POSTGRES_USER" \
  -d "$POSTGRES_DB" \
  --no-password \
  --format=plain \
  --no-owner \
  --no-privileges \
  | gzip > "$BACKUP_FILE"

BACKUP_SIZE=$(du -sh "$BACKUP_FILE" | cut -f1)
echo "[backup] Backup written: $BACKUP_FILE ($BACKUP_SIZE)"

# ── Upload to S3 (optional) ───────────────────────────────────────────────────
if [ -n "$S3_BUCKET" ] && [ -n "$AWS_ACCESS_KEY_ID" ]; then
  echo "[backup] Uploading to s3://$S3_BUCKET/..."

  ENDPOINT_FLAG=""
  if [ -n "$AWS_ENDPOINT_URL" ]; then
    ENDPOINT_FLAG="--endpoint-url $AWS_ENDPOINT_URL"
  fi

  aws s3 cp "$BACKUP_FILE" \
    "s3://${S3_BUCKET}/pf-backups/$(basename "$BACKUP_FILE")" \
    $ENDPOINT_FLAG \
    --storage-class STANDARD_IA

  echo "[backup] Upload complete."
else
  echo "[backup] S3_BUCKET not set — skipping offsite upload."
fi

# ── Prune old local backups ───────────────────────────────────────────────────
echo "[backup] Pruning local backups older than ${BACKUP_RETENTION_DAYS} days..."
find "$BACKUP_DIR" -name "pf_*.sql.gz" -mtime "+${BACKUP_RETENTION_DAYS}" -delete
REMAINING=$(find "$BACKUP_DIR" -name "pf_*.sql.gz" | wc -l)
echo "[backup] Retained $REMAINING backup(s) locally."

echo "[backup] Done at $(date -Iseconds)"
