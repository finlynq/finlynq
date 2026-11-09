-- Recalculate what was built from Yahoo's ROUNDED small-currency rates
-- (2026-11-09, GH #397). Runs after 20261109_fx_rates_drop_rounded_small_rates.
--
-- From May 2026 the live FX lookup stored Yahoo's 4-decimal rounded quote, so
-- a currency worth under 0.001 USD was stored wrong (IDR and UZS as 0.0001,
-- "1 USD = 10,000"). Two things were computed from those rates and stay wrong
-- after the rates are fixed:
--
--   1. transactions.reporting_amount: the amount in the user's reporting
--      currency, stored at the transaction date's rate. A non-null value in
--      the right currency looks healthy to selfHealReportingAmounts, so it is
--      never recalculated. This sets it to NULL on the rows that could have
--      used a rounded rate; the existing self-heal (recomputeReportingAmounts,
--      which treats NULL as stale) recalculates them on the user's next report
--      or dashboard load. Until then reports convert those rows on the fly at
--      the current rate, as they do for any row without a stored amount.
--   2. portfolio snapshots (net-worth and performance history): stamped stale
--      exactly as markAllSnapshotsStale does (cash: clear the dirty rows, then
--      the watermark; investment: dirty from the first snapshot since May), so
--      the next chart load rebuilds them.
--
-- Small currencies are read from fx_rates itself: any currency with a Yahoo
-- rate under 0.001 USD. The previous migration deleted only the ROUNDED rows,
-- so the correct ones remain and identify the currency (prod: IDR, UZS, COP,
-- KRW, ARS, VND). VND was never rounded (its rounded quote is 0, which already
-- fell back to the full-precision close); recalculating it changes nothing.
--
-- Scope: transactions dated 2026-05-01 or later (the first live rate was
-- stored in May 2026) whose account currency and reporting currency differ
-- and either one is a small currency. Booked amounts (`amount`, `entered_*`)
-- are never touched: those are the ledger.
--
-- The runner wraps the file in a transaction with the schema_migrations
-- insert, so there is no BEGIN/COMMIT. Idempotent: a second run finds the
-- rows already NULL (or recalculated, which it NULLs again harmlessly).

CREATE TEMP TABLE _fx_small_ccy ON COMMIT DROP AS
SELECT DISTINCT UPPER(currency) AS currency
  FROM fx_rates
 WHERE source = 'yahoo' AND rate_to_usd > 0 AND rate_to_usd < 0.001;

CREATE TEMP TABLE _fx_small_users ON COMMIT DROP AS
SELECT DISTINCT t.user_id
  FROM transactions t
 WHERE t.date >= '2026-05-01'
   AND UPPER(t.currency) IS DISTINCT FROM UPPER(t.reporting_currency)
   AND (UPPER(t.currency) IN (SELECT currency FROM _fx_small_ccy)
        OR UPPER(t.reporting_currency) IN (SELECT currency FROM _fx_small_ccy))
UNION
SELECT DISTINCT a.user_id
  FROM accounts a
 WHERE UPPER(a.currency) IN (SELECT currency FROM _fx_small_ccy)
UNION
SELECT DISTINCT s.user_id
  FROM settings s
 WHERE s.key = 'display_currency'
   AND UPPER(s.value) IN (SELECT currency FROM _fx_small_ccy);

-- 1. Reporting amounts → recalculated by the self-heal on next load.
UPDATE transactions t
   SET reporting_amount = NULL,
       updated_at = NOW()
 WHERE t.date >= '2026-05-01'
   AND t.reporting_amount IS NOT NULL
   AND UPPER(t.currency) IS DISTINCT FROM UPPER(t.reporting_currency)
   AND (UPPER(t.currency) IN (SELECT currency FROM _fx_small_ccy)
        OR UPPER(t.reporting_currency) IN (SELECT currency FROM _fx_small_ccy));

-- 2a. Cash snapshots: dirty rows first, then the watermark (a NULL watermark
--     means full invalidation; the order matches markAllSnapshotsStale).
DELETE FROM portfolio_cash_snapshot_dirty
 WHERE user_id IN (SELECT user_id FROM _fx_small_users);
DELETE FROM portfolio_cash_snapshot_meta
 WHERE user_id IN (SELECT user_id FROM _fx_small_users);

-- 2b. Investment snapshots: dirty from the first snapshot since May.
INSERT INTO portfolio_snapshot_dirty (user_id, from_date, marked_at)
SELECT ps.user_id, MIN(ps.snap_date), NOW()
  FROM portfolio_snapshots ps
 WHERE ps.source <> 'cash'
   AND ps.snap_date >= '2026-05-01'
   AND ps.user_id IN (SELECT user_id FROM _fx_small_users)
 GROUP BY ps.user_id
ON CONFLICT (user_id) DO UPDATE
  SET from_date = LEAST(portfolio_snapshot_dirty.from_date, EXCLUDED.from_date),
      marked_at = NOW();
