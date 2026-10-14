-- Investment snapshot cost basis at HISTORICAL exchange rates (2026-10-14,
-- owner report: "why would cost change? cost should be fixed unless there is
-- a transaction").
--
-- The snapshot builder converted each account's cost basis into the reporting
-- currency at the SNAPSHOT date's rate, the same rate as market value. For any
-- position or cash bought in another currency, the Performance chart's cost
-- line therefore moved every day the exchange rate did, with no transaction
-- behind it (and stayed flat on weekends). Measured on one real portfolio over
-- three months: about 10k of back-and-forth on days with no transaction.
--
-- The builder now values cost at each purchase's own date (the stored
-- transactions.reporting_amount). Nothing about the stored rows can be
-- corrected in place, so this trips the existing staleness machinery and the
-- next DEK-bearing chart load rebuilds the history, as the FINLYNQ-303
-- migration did.
--
-- Scoped to users whose holdings or investment accounts are in a currency
-- other than their reporting currency: for everyone else cost at the
-- purchase-date rate and cost at the snapshot-date rate are the same number,
-- so a rebuild would change nothing.
--
-- The runner wraps the file in a transaction with the schema_migrations
-- bookkeeping insert, so there is no BEGIN/COMMIT here. Idempotent: LEAST on
-- conflict keeps any wider pending range.

INSERT INTO portfolio_snapshot_dirty (user_id, from_date, marked_at)
SELECT ps.user_id, MIN(ps.snap_date), NOW()
  FROM portfolio_snapshots ps
 WHERE ps.source <> 'cash'
   AND EXISTS (
     SELECT 1
       FROM portfolio_holdings ph
       JOIN accounts a ON a.id = ph.account_id
       LEFT JOIN settings s ON s.user_id = ph.user_id AND s.key = 'display_currency'
      WHERE ph.user_id = ps.user_id
        AND (UPPER(ph.currency) <> UPPER(COALESCE(s.value, 'USD'))
             OR UPPER(a.currency) <> UPPER(COALESCE(s.value, 'USD')))
   )
 GROUP BY ps.user_id
ON CONFLICT (user_id) DO UPDATE
  SET from_date = LEAST(portfolio_snapshot_dirty.from_date, EXCLUDED.from_date),
      marked_at = NOW();
