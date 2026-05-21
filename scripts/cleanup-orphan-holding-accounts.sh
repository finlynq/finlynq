#!/usr/bin/env bash
# cleanup-orphan-holding-accounts.sh — one-off operator helper for FINLYNQ-6.
#
# Deletes orphan `holding_accounts` rows: pairings where no `transactions`
# row actually references the (user, holding, account) triple. These rows
# accumulate from past misuse of MCP `update_portfolio_holding(account=...)`
# (refused since issue #99, 2026-05-01) and from cleanup gaps after holdings
# get re-attributed by hand. Aggregators ignore them today (the JOIN through
# `holding_accounts` finds zero matching transactions), but they bloat the
# table and can surface as ghost `(holding, account)` pairs in any future
# query that doesn't go through the aggregator path.
#
# The SQL is also documented in:
#   pf-app/docs/architecture/mcp.md (under issue #99 invariant)
#   CLAUDE.md (under "update_portfolio_holding REFUSES the account parameter")
#
# Usage:
#   # Dry-run (default) — prints the orphan count, runs no DELETE.
#   DATABASE_URL='postgres://finlynq_dev:...@127.0.0.1/pf_dev' \
#     ./scripts/cleanup-orphan-holding-accounts.sh
#
#   # Apply — runs the DELETE inside a single transaction.
#   DATABASE_URL='postgres://finlynq_dev:...@127.0.0.1/pf_dev' \
#     ./scripts/cleanup-orphan-holding-accounts.sh --apply
#
# Per-env playbook:
#   1. DEV FIRST. Run `--apply` against the dev DB. Spot-check that
#      portfolio pages still render correctly and `get_portfolio_analysis`
#      returns the same holdings as before.
#   2. PROD ONLY AFTER A BACKUP. Take a fresh `pg_dump` of prod, then run
#      `--apply` against prod.
#   3. Both DBs share the same Postgres instance on the VPS; run with the
#      env's own role + db (finlynq_dev/pf_dev, finlynq_prod/pf — the demo
#      user lives inside the prod DB per the "Prod and demo coexist" gotcha
#      in CLAUDE.md, so the prod run cleans demo orphans too).
#
# Safety notes:
#   - No app code is touched. No data is migrated. This is a pure DELETE on
#     rows that have zero transactions referencing them.
#   - The pairings are CACHE rows. Aggregators read live qty/cost from
#     `transactions` (issue #99); deleting orphans cannot change any
#     user-visible number.
#   - DELETE runs inside `BEGIN; ... COMMIT;` so a mid-statement failure
#     rolls back cleanly.

set -euo pipefail

APPLY=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    -h|--help)
      sed -n '2,40p' "$0"
      exit 0
      ;;
    *)
      echo "[cleanup-orphan-ha] Unknown argument: $arg" >&2
      echo "[cleanup-orphan-ha] Usage: $0 [--apply]" >&2
      exit 2
      ;;
  esac
done

if [ -z "${DATABASE_URL:-}" ]; then
  echo "[cleanup-orphan-ha] ERROR: DATABASE_URL is not set." >&2
  echo "[cleanup-orphan-ha] Export the env's connection string before running." >&2
  echo "[cleanup-orphan-ha]   e.g. DATABASE_URL='postgres://finlynq_dev:...@127.0.0.1/pf_dev'" >&2
  exit 2
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "[cleanup-orphan-ha] ERROR: psql not found on PATH." >&2
  exit 2
fi

COUNT_SQL="SELECT COUNT(*) FROM holding_accounts ha
WHERE NOT EXISTS (
  SELECT 1 FROM transactions t
  WHERE t.user_id = ha.user_id
    AND t.portfolio_holding_id = ha.holding_id
    AND t.account_id = ha.account_id
);"

echo "[cleanup-orphan-ha] Counting orphan holding_accounts rows..."
ORPHAN_COUNT=$(psql "$DATABASE_URL" -X -A -t -c "$COUNT_SQL" | tr -d '[:space:]')

echo "[cleanup-orphan-ha] Orphan rows found: $ORPHAN_COUNT"

if [ "$ORPHAN_COUNT" = "0" ]; then
  echo "[cleanup-orphan-ha] Nothing to clean up. Exiting."
  exit 0
fi

if [ "$APPLY" -ne 1 ]; then
  echo "[cleanup-orphan-ha] Dry-run only. Re-run with --apply to delete."
  exit 0
fi

echo "[cleanup-orphan-ha] --apply set. Running DELETE inside a transaction..."

# Use ON_ERROR_STOP so a failed statement aborts the transaction and exits non-zero.
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;

-- Audit before
SELECT COUNT(*) AS orphan_count_before
FROM holding_accounts ha
WHERE NOT EXISTS (
  SELECT 1 FROM transactions t
  WHERE t.user_id = ha.user_id
    AND t.portfolio_holding_id = ha.holding_id
    AND t.account_id = ha.account_id
);

-- The DELETE itself
DELETE FROM holding_accounts ha
WHERE NOT EXISTS (
  SELECT 1 FROM transactions t
  WHERE t.user_id = ha.user_id
    AND t.portfolio_holding_id = ha.holding_id
    AND t.account_id = ha.account_id
);

-- Verify (should be 0)
SELECT COUNT(*) AS orphan_count_after
FROM holding_accounts ha
WHERE NOT EXISTS (
  SELECT 1 FROM transactions t
  WHERE t.user_id = ha.user_id
    AND t.portfolio_holding_id = ha.holding_id
    AND t.account_id = ha.account_id
);

COMMIT;
SQL

echo "[cleanup-orphan-ha] Done."
