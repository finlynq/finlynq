-- One-off cleanup: per-user rows left behind by pre-fix account deletions.
--
-- `deleteAllUserDataTx` (src/lib/auth/queries.ts) never reached a family of
-- per-user tables that carry NO foreign key to `users`, so neither
-- "wipe account" nor "delete account" removed them. Verified on pf_dev
-- 2026-07-27: after a successful POST /api/auth/delete-account (users row
-- gone, accounts gone) a scan of every public table with a user_id column
-- still found `securities` (4 rows — the user's DEK-encrypted symbol_ct /
-- name_ct / symbol_lookup / name_lookup) and `portfolio_cash_snapshot_meta`
-- (1 row) for the deleted user id.
--
-- The code fix stops NEW residue; this migration removes what already
-- accumulated. It only ever deletes rows whose `user_id` matches no `users`
-- row, so it cannot touch a live account: idempotent, and a no-op on a clean
-- database. Re-verify afterwards with scripts/scan-user-residue.sql.
--
-- Scope is exactly the tables that lacked a users FK. Tables with
-- `REFERENCES users(id) ON DELETE CASCADE` (webhooks, backfill_runs, …) cannot
-- hold orphans by construction. `custom_security_prices` is omitted on purpose:
-- its security_id is NOT NULL ON DELETE CASCADE, so it goes with `securities`.
-- `feedback` is EXCLUDED by design — feedback rows are maintainer-owned support
-- records that deliberately outlive the account (FINLYNQ-226/228).

DO $$
DECLARE
  t text;
  n bigint;
  total bigint := 0;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'portfolio_snapshots',
    'portfolio_snapshot_dirty',
    'portfolio_cash_snapshot_dirty',
    'portfolio_cash_snapshot_meta',
    'portfolio_lots_status',
    'portfolio_legacy_realized_gain_snapshot',
    'reporting_recompute_status',
    'mcp_idempotency_keys',
    'announcement_reads',
    -- last: cascades custom_security_prices
    'securities'
  ] LOOP
    -- Skip tables not present on this deployment (older self-hosted schemas).
    IF to_regclass('public.' || t) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      'DELETE FROM public.%I x WHERE NOT EXISTS '
      '(SELECT 1 FROM public.users u WHERE u.id = x.user_id)',
      t
    );
    GET DIAGNOSTICS n = ROW_COUNT;
    total := total + n;
    IF n > 0 THEN
      RAISE NOTICE 'cleanup_orphaned_user_rows: % — deleted % orphaned row(s)', t, n;
    END IF;
  END LOOP;

  RAISE NOTICE 'cleanup_orphaned_user_rows: % row(s) removed in total', total;
END $$;
