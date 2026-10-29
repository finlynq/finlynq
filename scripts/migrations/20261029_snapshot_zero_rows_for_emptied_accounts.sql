-- An emptied investment account reads zero in the Net Worth history
-- (2026-10-29, in-app feedback #27).
--
-- The investment snapshot builder wrote a per-account row only for accounts
-- holding something that day. An account emptied by a full withdrawal (or a
-- full sale) got no more rows, and the Net Worth chart carries each account's
-- LAST row forward, so the account kept its pre-withdrawal value in every
-- later point until the live value took over on the final day. One report:
-- HK$115k carried for five years, then a one-day "cliff" with no real loss.
--
-- The builder now writes a zero row for such an account (from its first
-- holding transaction onward). Rows that were never written can't be fixed in
-- place, so this trips the existing staleness machinery from the day each
-- emptied account's rows stopped, and the next DEK-bearing chart load
-- rebuilds from there, as the 20261014 migration did.
--
-- "Emptied" = an account whose per-account rows stop before the user's
-- whole-portfolio aggregate row does (the aggregate is written every day of a
-- rebuild). Users with no such account are untouched.
--
-- The runner wraps the file in a transaction with the schema_migrations
-- bookkeeping insert, so there is no BEGIN/COMMIT here. Idempotent: LEAST on
-- conflict keeps any wider pending range.

INSERT INTO portfolio_snapshot_dirty (user_id, from_date, marked_at)
SELECT acct.user_id, MIN(acct.last_date), NOW()
  FROM (
    SELECT user_id, account_id, MAX(snap_date) AS last_date
      FROM portfolio_snapshots
     WHERE source <> 'cash' AND account_id IS NOT NULL
     GROUP BY user_id, account_id
  ) acct
  JOIN (
    SELECT user_id, MAX(snap_date) AS last_agg
      FROM portfolio_snapshots
     WHERE source <> 'cash' AND account_id IS NULL
     GROUP BY user_id
  ) agg ON agg.user_id = acct.user_id
 WHERE acct.last_date < agg.last_agg
 GROUP BY acct.user_id
ON CONFLICT (user_id) DO UPDATE
  SET from_date = LEAST(portfolio_snapshot_dirty.from_date, EXCLUDED.from_date),
      marked_at = NOW();
