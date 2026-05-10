-- 20260510_data-fix-receipt-sign-and-fx-reval-rounding.sql -- issue #229.
--
-- One-time historical data migration. Two non-destructive UPDATE-in-place
-- fixes for residual rows that pre-date the pipeline guards from PR #225
-- (issue #212, sign-vs-category validator at every tx-write callsite) and
-- PR #221 (issue #208, IEEE-754 rounding hygiene). Forward-going writers
-- are clean; this aligns the historical rows with the new invariants.
--
-- Runner contract: deploy.sh wraps this file in a transaction with the
-- schema_migrations bookkeeping INSERT -- do NOT add an inner BEGIN/COMMIT.
-- Filename charset is [A-Za-z0-9_-].
--
-- =====================================================================
-- Part A -- receipt-OCR April 2026 sign flip
-- =====================================================================
-- Cohort: pre-validator E-type rows on the auditor's user/account 605,
-- ingested with positive amounts on 2026-04 dates. Likely receipt-OCR
-- batch from immediately before PR #225 landed (validator now refuses
-- E-type with amount > 0 on insert).
--
-- Dev-side SELECT (2026-05-10) confirmed 8 rows in this exact predicate
-- on user 6c4f164a-..., account 605 (the auditor's user) summing to
-- ~$1341 -- closely matches the issue's "~7 rows / ~$880 net swing"
-- description. Predicate is intentionally tight: scoped to E-type +
-- positive amount + April 2026 date window, so older legitimate
-- data-entry mistakes (out of scope per the issue) and other users'
-- rows are NOT touched on prod.
--
-- Post-state: every flipped row has amount < 0, which passes
-- validateSignVsCategory (E => amount <= 0). Verification query:
--
--   SELECT COUNT(*) FROM transactions t JOIN categories c ON c.id=t.category_id
--   WHERE c.type='E' AND t.amount > 0 AND t.date BETWEEN '2026-04-01' AND '2026-04-30';
--   -- expected: 0
--
-- Idempotency: re-run finds no E+ rows in the window (post-flip they are
-- all amount < 0) -> 0 rows updated. Safe to re-run.
--
-- Audit-trio invariant (CLAUDE.md "Audit trio (issue #28)"): updated_at
-- bumped to NOW(); source is INSERT-only and is NOT in the SET clause.

UPDATE transactions t
SET amount = -ABS(amount),
    updated_at = NOW()
FROM categories c
WHERE t.category_id = c.id
  AND c.type = 'E'
  AND t.amount > 0
  AND t.date BETWEEN '2026-04-01' AND '2026-04-30';

-- =====================================================================
-- Part B -- round transactions.amount to 2dp where IEEE-754 drift
-- =====================================================================
-- Cohort: rows where the persisted amount column carries 4-8 decimals
-- from the FX-revaluation cron / older write paths prior to PR #221's
-- rounding hygiene. The display layer rounds these on read; this aligns
-- the persisted column.
--
-- Dev-side SELECT (2026-05-10) confirmed 54 rows; auditor's specific
-- rows id 37619 (4dp: 9.8252) and id 37898 (8dp: 1.96511214) are in the
-- set. All affected rows are CAD or USD (no JPY/BTC sub-cent-intentional
-- currencies in the population today; out-of-scope per source review).
--
-- Post-state: every row passes amount = ROUND(amount, 2). Verification:
--
--   SELECT COUNT(*) FROM transactions WHERE amount::numeric != ROUND(amount::numeric, 2);
--   -- expected: 0
--
-- Idempotency: re-run finds no sub-cent-precision rows (post-round they
-- all match ROUND(amount, 2)) -> 0 rows updated. Safe to re-run.
--
-- Audit-trio invariant: updated_at bumped to NOW(); source preserved.
-- Forward-going writer is patched: src/lib/currency-conversion.ts
-- round2() at line 39+87 + src/lib/cron/settle-future-fx.ts routes
-- through convertToAccountCurrency which round2()s the amount.

UPDATE transactions
SET amount = ROUND(amount::numeric, 2),
    updated_at = NOW()
WHERE amount::numeric != ROUND(amount::numeric, 2);
