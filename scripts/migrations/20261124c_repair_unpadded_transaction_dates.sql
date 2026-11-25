-- Repair transaction dates stored without zero padding (2026-11-24).
--
-- The web transaction routes accepted any text as a date until today, so one
-- prod transaction was saved as "2026-09-4". Dates are stored as text and
-- compared as text everywhere (reports, balances, net-worth snapshots), so
-- that row sorted after 2026-09-30, its weekday could not be worked out (the
-- insights request failed on every load for that user), and its historical
-- exchange-rate lookup failed daily. The routes now refuse such dates
-- (src/lib/schemas/iso-date.ts); this fixes rows already stored.
--
-- Only dates of the form YYYY-M[M]-D[D] that are a real calendar date are
-- rewritten, to YYYY-MM-DD; nothing else about the row changes (amount,
-- payee, links). Prod: 1 row ("2026-09-4" -> "2026-09-04"); dev: none.
-- Anything still malformed afterwards is left for a person to look at.
--
-- Balance history built while the date was wrong is marked stale from the
-- corrected date, the same way a date edit does (cash per account; the
-- per-user investment marker when the row is on a holding), so the next
-- chart load rebuilds it. A NULL reporting_amount is recalculated by the
-- existing self-heal; a stored one was computed at the nearest cached rate
-- and is left alone.
--
-- The runner wraps the file in a transaction with the schema_migrations
-- insert, so there is no BEGIN/COMMIT. Idempotent: a second run matches no row.

CREATE TEMP TABLE _date_fix ON COMMIT DROP AS
SELECT id, user_id, account_id, portfolio_holding_id, date AS old_date,
       split_part(date, '-', 1)::int AS y,
       split_part(date, '-', 2)::int AS m,
       split_part(date, '-', 3)::int AS d,
       NULL::text AS new_date
  FROM transactions
 WHERE date ~ '^\d{4}-\d{1,2}-\d{1,2}$'
   AND date !~ '^\d{4}-\d{2}-\d{2}$';

-- Postgres raises an error on an impossible date rather than skipping it, so
-- the month and day are checked before any date is built (2026-2-30 stays).
DELETE FROM _date_fix WHERE m NOT BETWEEN 1 AND 12 OR d < 1;
DELETE FROM _date_fix
 WHERE d > extract(day FROM make_date(y, m, 1) + interval '1 month - 1 day');

UPDATE _date_fix SET new_date = to_char(make_date(y, m, d), 'YYYY-MM-DD');

UPDATE transactions t
   SET date = f.new_date, updated_at = NOW()
  FROM _date_fix f
 WHERE t.id = f.id;

-- Cash history per account, from the earlier of the stored marker and the
-- corrected date (as markCashSnapshotsDirty does).
INSERT INTO portfolio_cash_snapshot_dirty (user_id, account_id, from_date, marked_at)
SELECT user_id, account_id, MIN(new_date), NOW()
  FROM _date_fix
 WHERE account_id IS NOT NULL
 GROUP BY user_id, account_id
ON CONFLICT (user_id, account_id) DO UPDATE
   SET from_date = LEAST(portfolio_cash_snapshot_dirty.from_date, EXCLUDED.from_date),
       marked_at = NOW();

-- Investment history, per user, only when a fixed row is on a holding.
INSERT INTO portfolio_snapshot_dirty (user_id, from_date, marked_at)
SELECT user_id, MIN(new_date), NOW()
  FROM _date_fix
 WHERE portfolio_holding_id IS NOT NULL
 GROUP BY user_id
ON CONFLICT (user_id) DO UPDATE
   SET from_date = LEAST(portfolio_snapshot_dirty.from_date, EXCLUDED.from_date),
       marked_at = NOW();
