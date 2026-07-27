-- Residue scan: does any row anywhere still belong to a given user?
--
-- The runtime counterpart to tests/delete-all-user-data-coverage.test.ts. That
-- test proves `deleteAllUserDataTx` NAMES every per-user table; this proves the
-- database agrees. Run it after a wipe or a delete-account to confirm zero rows
-- survive — that is how the securities / portfolio_cash_snapshot_meta residue
-- was found on pf_dev (2026-07-27).
--
-- Usage (read-only, safe on prod):
--   psql -d pf_dev -v uid='<user-uuid>' -f scripts/scan-user-residue.sql
--
-- Prints one row per table that still holds data for :uid. An EMPTY result is
-- the pass condition. After a DELETE-ACCOUNT the users row is gone too, so
-- anything printed is unreachable residue. After a WIPE the users row remains
-- by design (only `users` itself should be absent from the output — it has no
-- user_id column, so it is never scanned).
--
-- Covers every `public` table carrying a `user_id` column, resolved at run time
-- from information_schema, so a table added after this file was written is
-- still scanned. Tables that hold user data WITHOUT a user_id column
-- (transaction_splits, incoming_emails) are reached through their parent and
-- are not listed here.

\if :{?uid}
\else
  \echo 'ERROR: pass the user id, e.g. -v uid=''00000000-0000-0000-0000-000000000000'''
  \quit 1
\endif

SELECT table_name, row_count
FROM (
  SELECT
    c.table_name,
    (xpath(
      '/row/cnt/text()',
      query_to_xml(
        format(
          'SELECT count(*) AS cnt FROM public.%I WHERE user_id::text = %L',
          c.table_name,
          :'uid'
        ),
        false, true, ''
      )
    ))[1]::text::bigint AS row_count
  FROM information_schema.columns c
  JOIN information_schema.tables t
    ON t.table_schema = c.table_schema
   AND t.table_name = c.table_name
   AND t.table_type = 'BASE TABLE'
  WHERE c.table_schema = 'public'
    AND c.column_name = 'user_id'
) scan
WHERE row_count > 0
ORDER BY table_name;
