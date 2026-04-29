-- accounts.is_investment + cash-holding backfill (2026-04-28)
--
-- Adds a boolean flag to accounts marking it as an investment account.
-- Investment accounts enforce that every transaction references a
-- portfolio_holdings row — trades point at their security; cash legs
-- (deposits, dividends paid as cash, fees, transfers) point at a per-account
-- "Cash" holding. The constraint is enforced at the application layer
-- (mirrors the four-check transfer-pair pattern in src/lib/transfer.ts);
-- there's no DB CHECK constraint because PostgreSQL can't express
-- "NOT NULL only when accounts.is_investment is true" without a trigger
-- and we already have the helper-and-call-sites idiom.
--
-- Backfill in three stages, all inside one transaction:
--
--   1. Heuristic flag flip — accounts with at least one portfolio_holdings
--      row are de facto investment accounts today. User can untoggle later
--      from the account edit dialog.
--
--   2. Cash holding ensure — every flagged account gets exactly one
--      `name='Cash'` portfolio_holdings row. No DEK is in scope here, so
--      name_ct / name_lookup stay NULL and get filled lazily on next login
--      via the Stream D Phase 4 resolver
--      (src/lib/external-import/portfolio-holding-resolver.ts).
--      The portfolio-overview cash branch in
--      src/app/api/portfolio/overview/route.ts:408 keys off
--      isCurrencyCodeSymbol(symbol) — symbol stays NULL on these rows so
--      the cash-vs-stock check uses the empty-symbol path
--      (src/app/(app)/portfolio/page.tsx:1650 "Empty symbol → cash holding").
--
--   3. Null-FK reassignment — transactions in flagged accounts where BOTH
--      portfolio_holding_id IS NULL AND portfolio_holding IS NULL get
--      pointed at the Cash holding. Rows with the legacy plaintext text
--      column populated are LEFT ALONE — the existing Phase-4 lazy backfill
--      resolver routes them to their actual holding on next login. Anything
--      still null after that lands in the admin orphan queue.
--
-- Idempotent — every step uses IF NOT EXISTS / WHERE NOT EXISTS / ON
-- CONFLICT. Safe to re-run; safe to run before OR after `npm run db:push`.
--
--   PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_prod    -d pf         -f scripts/migrate-accounts-is-investment.sql
--   PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_staging -d pf_staging -f scripts/migrate-accounts-is-investment.sql
--   PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_dev     -d pf_dev     -f scripts/migrate-accounts-is-investment.sql

BEGIN;

-- 1. New flag on accounts.
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS is_investment boolean NOT NULL DEFAULT false;

-- 2. Heuristic flag backfill — any account with ≥1 portfolio_holdings row
--    is an investment account. UPDATE is bounded to rows that aren't already
--    flagged so re-runs are no-ops.
UPDATE accounts a
   SET is_investment = true
 WHERE a.is_investment = false
   AND EXISTS (
     SELECT 1
       FROM portfolio_holdings ph
      WHERE ph.account_id = a.id
        AND ph.user_id = a.user_id
   );

-- 3. Cash holding ensure — for every is_investment account that doesn't
--    already have a holding named 'Cash' (case-insensitive, trimmed),
--    INSERT one. We can't use the partial UNIQUE index
--    portfolio_holdings_user_account_lookup_uniq because it requires
--    name_lookup IS NOT NULL, and we have no DEK to compute it. So we
--    dedup by plaintext name + account.
INSERT INTO portfolio_holdings
  (user_id, account_id, name, symbol, currency, is_crypto, note)
SELECT a.user_id,
       a.id,
       'Cash',
       NULL,
       a.currency,
       0,
       'auto-created for cash sleeve'
  FROM accounts a
 WHERE a.is_investment = true
   AND NOT EXISTS (
     SELECT 1
       FROM portfolio_holdings ph
      WHERE ph.user_id = a.user_id
        AND ph.account_id = a.id
        AND lower(trim(coalesce(ph.name, ''))) = 'cash'
   );

-- 4. Null-FK reassignment — point unattributed cash legs at the Cash holding.
--    Scoped to rows with NO existing signal (FK null AND legacy text null).
--    Rows where the legacy plaintext text column is populated stay untouched
--    so the Phase-4 lazy resolver can attribute them to their real holding.
UPDATE transactions t
   SET portfolio_holding_id = ph.id
  FROM accounts a, portfolio_holdings ph
 WHERE t.account_id = a.id
   AND a.is_investment = true
   AND t.user_id = a.user_id
   AND ph.user_id = a.user_id
   AND ph.account_id = a.id
   AND lower(trim(coalesce(ph.name, ''))) = 'cash'
   AND t.portfolio_holding_id IS NULL
   AND t.portfolio_holding IS NULL;

COMMIT;
