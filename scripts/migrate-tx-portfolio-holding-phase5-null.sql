-- transactions.portfolio_holding Phase 5 cutover — NULL the legacy plaintext
-- (encrypted) text column on every row whose portfolio_holding_id (FK) is
-- already populated. After this runs, the FK is the sole source of truth for
-- which holding a tx belongs to; the orphan-fallback decrypt loops in the
-- read paths become dead code and are removed in the same release.
--
-- Gate: /api/admin/portfolio-holding-fk-progress must report
-- `{ withoutFk: 0 }` (steady) before running. Verified on prod 2026-04-29.
--
-- Idempotent — re-running is a no-op once portfolio_holding is NULL on every
-- backfilled row.
--
-- DO NOT RUN until:
--   (1) /api/admin/portfolio-holding-fk-progress reports `withoutFk = 0`, AND
--   (2) the matching code change (drop "portfolioHolding" from
--       TX_ENCRYPTED_FIELDS + delete the orphan-fallback decrypt loops) is
--       ready to deploy. Per CLAUDE.md's deploy sequencing for encryption
--       rollouts: migration first, then code push.
--
-- Reversible? Not fully — the encrypted plaintext is gone from backfilled
-- rows. The FK + portfolio_holdings.name (or name_ct) is the authoritative
-- name source going forward.

BEGIN;

-- Pre-check: every row that still has plaintext must already have an FK.
-- If withoutFk > 0 we'd be NULLing the only signal for un-backfilled rows.
DO $$
DECLARE
  missing int;
BEGIN
  SELECT COUNT(*) INTO missing
    FROM transactions
   WHERE portfolio_holding IS NOT NULL
     AND portfolio_holding_id IS NULL;
  IF missing > 0 THEN
    RAISE EXCEPTION 'transactions: % rows have plaintext portfolio_holding but no FK — gate must be 0 before Phase 5 cutover', missing;
  END IF;
END $$;

-- NULL the plaintext on every backfilled row.
UPDATE transactions
   SET portfolio_holding = NULL
 WHERE portfolio_holding_id IS NOT NULL
   AND portfolio_holding IS NOT NULL;

COMMIT;

-- Post-migration verification:
--   SELECT count(*) FROM transactions WHERE portfolio_holding IS NOT NULL;
--   -- should be 0
--   SELECT count(*) FROM transactions WHERE portfolio_holding_id IS NOT NULL;
--   -- unchanged from pre-migration (FKs intact)
