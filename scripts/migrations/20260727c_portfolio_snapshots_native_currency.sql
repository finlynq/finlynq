-- Dual-basis balances: store each snapshot in the ACCOUNT's native currency
-- alongside the existing reporting-currency value (FINLYNQ-303).
--
-- Until now `portfolio_snapshots` carried exactly ONE money pair
-- (market_value + currency), always in the user's reporting currency: both
-- writers convert before the INSERT (cash-builder.ts `running * rate`,
-- builder.ts `v.value * fxRate`). So a foreign-currency account had no
-- persisted history in its own currency, and the account detail page showed
-- its Balance tile in native currency while the chart directly beneath it drew
-- the reporting currency — two different numbers for the same account.
--
-- The native value is NOT derived from the stored one. It is the INPUT to that
-- conversion and already exists in memory in both builders; these columns just
-- stop discarding it. That also means existing rows CANNOT be backfilled by
-- dividing market_value by a rate: rows written with gaps_filled = true used a
-- rate=1 fallback, so division would silently produce a native value identical
-- to the reporting one. The columns are therefore left NULL here and populated
-- by a normal rebuild (the deploy bumps the staleness watermarks so every
-- user's next chart load rebuilds both bases).
--
-- native_currency is the ACCOUNT currency for a per-account row. The
-- whole-portfolio aggregate row (account_id IS NULL) spans accounts of
-- differing currencies and has no single native currency, so BOTH columns stay
-- NULL there permanently — a native basis is only ever defined for one account.
--
-- Purely additive (nullable columns, no rewrite of existing rows), so deploy.sh
-- applies it with no code-first/SQL-second dance.
--
-- The runner in deploy.sh wraps the file in a transaction with the
-- schema_migrations bookkeeping insert — do NOT add a BEGIN/COMMIT here.

ALTER TABLE portfolio_snapshots
  ADD COLUMN IF NOT EXISTS native_market_value DOUBLE PRECISION;

ALTER TABLE portfolio_snapshots
  ADD COLUMN IF NOT EXISTS native_currency TEXT;

-- ── Force the one-time dual-basis rebuild ───────────────────────────────────
-- The columns above land NULL on every existing row, and the read path treats
-- a native series as all-or-nothing (a partially-native series would draw one
-- line whose points are partly account-currency and partly display-currency).
-- So until each user's history is rebuilt, a native request downgrades to
-- reporting. These two statements trip the EXISTING staleness machinery so the
-- rebuild happens on each user's next chart load — no new backfill script, and
-- no rebuild for users who never open the app.

-- Cash: isCashStale() returns true for a missing watermark row, and the
-- self-heal's null-meta path is a full-history rebuild. DEK-free, so this
-- self-heals for every user regardless of who logs in.
DELETE FROM portfolio_cash_snapshot_meta;

-- Investment: stamp the dirty queue from each user's own earliest snapshot so
-- the rebuild covers their whole history. Unlike cash this needs a session DEK
-- (holding symbols are encrypted — see builder.ts), so it fires on the next
-- DEK-bearing chart load. LEAST on conflict keeps any wider pending range.
INSERT INTO portfolio_snapshot_dirty (user_id, from_date, marked_at)
SELECT user_id, MIN(snap_date), NOW()
  FROM portfolio_snapshots
 WHERE source <> 'cash'
 GROUP BY user_id
ON CONFLICT (user_id) DO UPDATE
  SET from_date = LEAST(portfolio_snapshot_dirty.from_date, EXCLUDED.from_date),
      marked_at = NOW();
