-- Category override for pair-less income kinds in the backfill engine.
--
-- Context: when the user overrides a refused `orphan_stock_leg` proposal to a
-- pair-less income kind (`dividend` / `interest` / `portfolio_income` /
-- `portfolio_expense`), the apply path UPDATEs `kind` but never set
-- `category_id` — the row kept its existing (usually NULL) category. A dividend
-- canonicalized through the backfill therefore silently dropped out of the
-- Dividend Income report (which matches only on the user's "Dividends"
-- category). This column lets the user pick a category in the review UI;
-- apply stamps it on the row. When NULL for a dividend/interest override, apply
-- resolves-or-creates the canonical "Dividends"/"Interest" category instead.
--
-- Mirrors the `chosen_related_holding_id` column from
-- 20260609_backfill_kind_override.sql. Nullable; NULL for every proposal that
-- isn't a pair-less income override.
--
-- The runner in deploy.sh wraps each migration in a transaction
-- (psql --single-transaction with ON_ERROR_STOP=1); do NOT add BEGIN/COMMIT.

ALTER TABLE backfill_proposals
  ADD COLUMN IF NOT EXISTS chosen_category_id INTEGER
    REFERENCES categories(id) ON DELETE SET NULL;
