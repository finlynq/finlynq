#!/usr/bin/env bash
#
# Finlynq backup recovery playbook.
#
# Encryption-at-rest (Open #5 from SECURITY_HANDOVER_2026-05-07.md): backups
# in /opt/finlynq-backups/ are encrypted with gpg --symmetric AES-256 when
# a passphrase file exists at $BACKUP_ENCRYPTION_KEY_FILE (default
# /etc/finlynq/backup-key). This script decrypts and either prints the SQL
# to stdout (default) or restores it into a target database (--restore).
#
# ─── Setup (one-time, per-host) ────────────────────────────────────────────
#
# Generate a long, random passphrase ONCE per host and store it 0400 / root:
#
#   sudo install -d -m 0700 -o root -g root /etc/finlynq
#   sudo bash -c 'openssl rand -base64 64 > /etc/finlynq/backup-key'
#   sudo chmod 0400 /etc/finlynq/backup-key
#   sudo chown root:root /etc/finlynq/backup-key
#
# IMPORTANT: ALSO store this passphrase OFF-BOX (e.g. 1Password vault, Bitwarden,
# physical safe). The deploy.sh-encrypted backups are useless without the key,
# so a host loss + lost-key-file means the backups are unrecoverable.
#
# Then either rotate keys forward (`gpg --decrypt --batch ... | gpg --symmetric
# --new-passphrase ...`) on every passphrase change, or accept that old backups
# stay decryptable only with the old passphrase.
#
# ─── Usage ─────────────────────────────────────────────────────────────────
#
#   sudo bash restore-backup.sh /opt/finlynq-backups/pf-dev_20260507_171234.sql.gpg
#       Prints decrypted SQL to stdout. Pipe to less / inspect / save.
#
#   sudo bash restore-backup.sh /opt/finlynq-backups/pf_20260507_171234.sql.gpg \
#        --restore postgresql://finlynq_recovery@/finlynq_recovery
#       Decrypts and pipes into psql against the supplied DB URL. Recovery
#       database MUST be a fresh empty DB — pg_dump output is "DROP+CREATE+..."
#       and will clobber an existing schema.
#
#   sudo bash restore-backup.sh /opt/finlynq-backups/pf_legacy.sql
#       Plaintext (.sql) input passes through as-is.
#
# ─── Key file resolution ──────────────────────────────────────────────────
#
# Same lookup as deploy.sh: $BACKUP_ENCRYPTION_KEY_FILE env var, default
# /etc/finlynq/backup-key. Override via env if you stored the key elsewhere.

set -euo pipefail

usage() {
  echo "Usage: $0 <backup-file.{sql,sql.gpg}> [--restore <DATABASE_URL>]"
  echo ""
  echo "Examples:"
  echo "  $0 /opt/finlynq-backups/pf-dev_20260507_171234.sql.gpg"
  echo "  $0 /opt/finlynq-backups/pf_20260507_171234.sql.gpg --restore postgresql://..."
  echo ""
  echo "Env: BACKUP_ENCRYPTION_KEY_FILE (default /etc/finlynq/backup-key)"
  exit 1
}

if [ $# -lt 1 ]; then usage; fi

BACKUP_FILE="$1"
RESTORE_URL=""

shift
while [ $# -gt 0 ]; do
  case "$1" in
    --restore)
      RESTORE_URL="${2:-}"
      if [ -z "$RESTORE_URL" ]; then
        echo "ERROR: --restore requires a DATABASE_URL argument."
        exit 1
      fi
      shift 2
      ;;
    *)
      echo "ERROR: unknown option: $1"
      usage
      ;;
  esac
done

if [ ! -r "$BACKUP_FILE" ]; then
  echo "ERROR: backup file not readable: $BACKUP_FILE"
  echo "       (run with sudo if it lives in /opt/finlynq-backups/)"
  exit 1
fi

BACKUP_ENCRYPTION_KEY_FILE="${BACKUP_ENCRYPTION_KEY_FILE:-/etc/finlynq/backup-key}"

# Choose the decryption command based on filename.
case "$BACKUP_FILE" in
  *.sql.gpg)
    if ! command -v gpg >/dev/null 2>&1; then
      echo "ERROR: gpg not on PATH; install with 'apt-get install gnupg'."
      exit 1
    fi
    if [ ! -r "$BACKUP_ENCRYPTION_KEY_FILE" ]; then
      echo "ERROR: backup key file not readable at $BACKUP_ENCRYPTION_KEY_FILE."
      echo "       Set BACKUP_ENCRYPTION_KEY_FILE to its path, or run with sudo if"
      echo "       it's owned by root."
      exit 1
    fi
    DECRYPT_CMD=(gpg --batch --decrypt
                 --passphrase-file "$BACKUP_ENCRYPTION_KEY_FILE"
                 --no-tty --quiet
                 "$BACKUP_FILE")
    ;;
  *.sql)
    DECRYPT_CMD=(cat "$BACKUP_FILE")
    ;;
  *.sql.gz)
    if ! command -v gunzip >/dev/null 2>&1; then
      echo "ERROR: gunzip not on PATH."
      exit 1
    fi
    DECRYPT_CMD=(gunzip -c "$BACKUP_FILE")
    ;;
  *)
    echo "ERROR: unsupported backup extension: $BACKUP_FILE"
    echo "       Expected one of: .sql, .sql.gz, .sql.gpg"
    exit 1
    ;;
esac

if [ -n "$RESTORE_URL" ]; then
  if ! command -v psql >/dev/null 2>&1; then
    echo "ERROR: psql not on PATH."
    exit 1
  fi
  echo "==> Restoring $BACKUP_FILE into target database..."
  echo "    (target must be a FRESH database — existing schema will be clobbered)"
  read -r -p "    Continue? [y/N] " confirm
  case "$confirm" in
    y|Y|yes|YES) ;;
    *) echo "    Aborted."; exit 1 ;;
  esac
  "${DECRYPT_CMD[@]}" | psql "$RESTORE_URL" -v ON_ERROR_STOP=1
  echo "==> Restore complete."
else
  "${DECRYPT_CMD[@]}"
fi
