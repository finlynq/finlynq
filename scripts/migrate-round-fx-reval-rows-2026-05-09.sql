-- Issue #208 — round drifted FX-revaluation transactions to 2dp.
--
-- BACKGROUND
-- ----------
-- `convertToAccountCurrency` round2's `amount`, but earlier MCP write paths
-- bound `enteredAmount` raw — Claude could pass `enteredAmount: 1.96511214`
-- and it landed unrounded in the DB. Combined with `transactions.amount`
-- being doublePrecision, every aggregator's `SUM(t.amount)` compounded the
-- drift forever (e.g. `5598.589999990002`, `-13788.5204257`).
--
-- The MCP write boundary now rounds before INSERT (issue #208 PR), so net-new
-- rows are clean. This playbook repairs existing FX-revaluation rows that
-- carried sub-cent drift in `amount` and/or `entered_amount`.
--
-- AUDIT FIRST, REPAIR SECOND
-- --------------------------
-- Run the SELECT to see which rows are affected before committing the UPDATE.
-- Both statements are wrapped in a single transaction; the SELECT output is
-- captured by `psql` (or whatever client you use) before the COMMIT.
--
-- KEY POSTGRES CONSTRAINTS WE PRESERVE
-- ------------------------------------
-- 1. `updated_at` MUST be bumped on physical row mutation (CLAUDE.md "Audit
--    trio"). The settle-future-fx cron at
--    `pf-app/src/lib/cron/settle-future-fx.ts:79-85` follows the same
--    pattern. The WHERE clause guards against no-op rounding bumping
--    `updated_at` — rows already at 2dp don't match.
-- 2. `source` is INSERT-only and IS NOT modified — the `mcp_http` audit
--    attribution is preserved across the repair. The 7-value CHECK constraint
--    in `src/lib/tx-source.ts` enforces this at the DB level on any future
--    UPDATE that tries to change it.
-- 3. The repair runs against `payee = 'FX Translation P&L'` AND
--    `source = 'mcp_http'`. IBKR-imported reval rows use the same payee
--    string but `source = 'import'` and are deliberately excluded — if drift
--    shows up there, run a separate WHERE-clauseless statement after the
--    operator confirms.
--
-- USAGE
-- -----
--   psql "$DATABASE_URL" -f migrate-round-fx-reval-rows-2026-05-09.sql
--
-- The transaction commits at the end. Inspect the SELECT output above the
-- UPDATE in the same session — if anything looks wrong, ROLLBACK before
-- COMMIT (manual psql) or set `\set ON_ERROR_STOP on` and abort.
--
-- IDEMPOTENT — re-running after the first apply is a no-op (every targeted
-- row is already at 2dp; the WHERE clause filters them out).

BEGIN;

-- AUDIT — surfaces affected rows (both classes of drift). Inspect this
-- output before the UPDATE commits. The `(amount != ROUND(amount, 2) OR
-- entered_amount != ROUND(entered_amount, 2))` predicate matches any row
-- where either column carries sub-cent drift.
SELECT id, account_id, date, currency, amount, entered_currency, entered_amount,
       payee, source, updated_at
FROM transactions
WHERE payee = 'FX Translation P&L'
  AND source = 'mcp_http'
  AND (amount != ROUND(amount::numeric, 2)
       OR (entered_amount IS NOT NULL AND entered_amount != ROUND(entered_amount::numeric, 2)));

-- REPAIR — round amount + entered_amount to 2dp; bump updated_at; preserve
-- source. The CASE on entered_amount keeps NULLs as NULL. The WHERE clause
-- mirrors the AUDIT predicate so already-clean rows stay untouched.
UPDATE transactions
SET amount = ROUND(amount::numeric, 2),
    entered_amount = CASE
      WHEN entered_amount IS NULL THEN NULL
      ELSE ROUND(entered_amount::numeric, 2)
    END,
    updated_at = NOW()
WHERE payee = 'FX Translation P&L'
  AND source = 'mcp_http'
  AND (amount != ROUND(amount::numeric, 2)
       OR (entered_amount IS NOT NULL AND entered_amount != ROUND(entered_amount::numeric, 2)));

COMMIT;
