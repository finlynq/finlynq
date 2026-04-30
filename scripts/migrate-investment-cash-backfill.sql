-- Investment-account cash-holding backfill — strict-mode prerequisite (2026-04-30)
--
-- One-time backfill to satisfy the strict-enforcement switch for the
-- investment-account constraint (issue #22). Reassigns every transaction in
-- an `is_investment=true` account that still has `portfolio_holding_id IS NULL`
-- to the per-account 'Cash' holding so the strict path in src/lib/transfer.ts
-- (createTransferPair / createTransferPairViaSql) and src/lib/import-pipeline.ts
-- can refuse newly unattributed legs without breaking historical rows.
--
-- Narrower than `migrate-accounts-is-investment.sql`:
--   * That migration introduced the `is_investment` flag, planted the per-
--     account Cash holding, and reassigned transactions where BOTH the FK
--     `portfolio_holding_id` AND the legacy plaintext `portfolio_holding`
--     column were NULL. Phase 6 (2026-04-29) dropped the legacy column on
--     prod, so the "legacy text NULL" guard no longer makes sense — any
--     remaining NULL FK is a true orphan.
--   * This migration only touches transactions whose `portfolio_holding_id`
--     is NULL. It assumes Phase-4 + Phase-6 have already run on the env.
--
-- Idempotent — every step is `INSERT … WHERE NOT EXISTS` / `UPDATE …
-- WHERE … IS NULL`. Safe to re-run on the same env; safe to run before OR
-- after `npm run db:push`. Verifies completion before COMMIT so a partial
-- backfill (e.g. concurrent writes) raises rather than commits a half state.
--
-- Run BEFORE deploying the strict-enforcement code:
--   PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_prod    -d pf         -f scripts/migrate-investment-cash-backfill.sql
--   PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_staging -d pf_staging -f scripts/migrate-investment-cash-backfill.sql
--   PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_dev     -d pf_dev     -f scripts/migrate-investment-cash-backfill.sql
--
-- After each env, hit GET /api/admin/investment-orphans and verify
-- `{ complete: true, orphanCount: 0 }` before pushing the matching code.

BEGIN;

-- 1. Ensure every is_investment account has a 'Cash' holding. Same dedup
--    rule as migrate-accounts-is-investment.sql so re-running doesn't
--    duplicate. No DEK in scope so name_ct / name_lookup stay NULL and the
--    Phase-4 resolver fills them on next login.
INSERT INTO portfolio_holdings
  (user_id, account_id, name, symbol, currency, is_crypto, note)
SELECT a.user_id,
       a.id,
       'Cash',
       NULL,
       a.currency,
       0,
       'auto-created for cash sleeve (strict-mode backfill 2026-04-30)'
  FROM accounts a
 WHERE a.is_investment = true
   AND NOT EXISTS (
     SELECT 1
       FROM portfolio_holdings ph
      WHERE ph.user_id = a.user_id
        AND ph.account_id = a.id
        AND lower(trim(coalesce(ph.name, ''))) = 'cash'
   );

-- 2. Reassign every NULL-FK transaction in an investment account to the
--    per-account Cash holding. Unlike the original is-investment migration,
--    we no longer guard on `portfolio_holding IS NULL` because Phase 6
--    dropped that column. Anything still NULL here is a true orphan.
UPDATE transactions t
   SET portfolio_holding_id = ph.id
  FROM accounts a, portfolio_holdings ph
 WHERE t.account_id = a.id
   AND a.is_investment = true
   AND t.user_id = a.user_id
   AND ph.user_id = a.user_id
   AND ph.account_id = a.id
   AND lower(trim(coalesce(ph.name, ''))) = 'cash'
   AND t.portfolio_holding_id IS NULL;

-- 3. Verification — fail-loud before COMMIT if any orphans remain. The
--    strict-enforcement code in src/lib/transfer.ts + src/lib/import-pipeline.ts
--    refuses newly unattributed legs, so leaving historical orphans behind
--    would surface as "Pick a portfolio holding" errors on edit. Better to
--    abort the migration here than ship code that breaks edits silently.
DO $$
DECLARE
  orphan_count int;
BEGIN
  SELECT COUNT(*) INTO orphan_count
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id AND a.user_id = t.user_id
   WHERE a.is_investment = true
     AND t.portfolio_holding_id IS NULL;
  IF orphan_count > 0 THEN
    RAISE EXCEPTION 'investment-account orphans remain after backfill: %', orphan_count;
  END IF;
END $$;

COMMIT;
