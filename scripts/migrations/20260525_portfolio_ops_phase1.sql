-- Portfolio operations refactor — Phase 1 schema (2026-05-25).
--
-- Foundation for the 6-operation portfolio model documented in
-- C:\Users\halaw\.claude\plans\refactored-wishing-marshmallow.md.
-- Replaces the implicit "any transaction with portfolio_holding_id is a
-- portfolio operation" inference with an explicit `kind` discriminator on
-- transactions, an `is_cash` flag on portfolio_holdings to identify per-
-- currency cash sleeves, and an optional `related_holding_id` linkage so
-- portfolio income/expense rows landing on a cash sleeve can be attributed
-- back to the holding they pertain to (e.g., a USD dividend lands on
-- USD-cash but reports as "Apple dividend").
--
-- Pure additive at the column level: no DROP COLUMN, no behavior change
-- for callers that don't read the new columns. The user-visible behavior
-- change is engine-side: invalid link_id pairings (a stock paired with a
-- different stock or a cash sleeve) start being refused at write time
-- AFTER this migration lands AND the new write-hook classification
-- ships in src/lib/portfolio/lots/write-hooks.ts.
--
-- Cash sleeve detection rule for the in-migration backfill:
-- `symbol_ct IS NULL` — matches the existing getOrCreateCashHolding
-- auto-creation shape. Encrypted symbol decryption is not possible in raw
-- SQL (per-user DEK), so users with manually-created cash holdings whose
-- symbol_ct contains an encrypted currency code (e.g., "USD") MUST be
-- handled in a separate per-user pass (see operations.ts / cash-sleeve
-- normalization helpers, follow-up work).
--
-- The runner in deploy.sh wraps the file in a transaction with the
-- schema_migrations bookkeeping insert — do NOT add a BEGIN/COMMIT block
-- here.

-- ─── transactions.kind discriminator ─────────────────────────────────────
--
-- Explicit type tag for portfolio-related rows. Today the system infers
-- the operation type from (qty sign, link_id, category_id) heuristics;
-- the new column makes intent first-class so reporting can filter cleanly
-- ("show me all my dividends this year", "show me FX conversion fees")
-- without joining/inferring.
--
-- Allowed values (11):
--   'buy'                       — stock-leg of a Buy operation (qty > 0)
--   'buy_cash_leg'              — paired cash-side of a Buy (qty < 0 on cash sleeve)
--   'sell'                      — stock-leg of a Sell (qty < 0)
--   'sell_cash_leg'             — paired cash-side of a Sell (qty > 0 on cash sleeve)
--   'in_kind_transfer_in'       — destination leg of an in-kind transfer (same security, different account)
--   'in_kind_transfer_out'      — source leg of an in-kind transfer
--   'fx_from'                   — source-currency leg of an FX conversion (debits cash sleeve A)
--   'fx_to'                     — destination-currency leg of an FX conversion (credits cash sleeve B)
--   'fx_fee'                    — optional third leg of an FX conversion (fee on user-picked sleeve)
--   'portfolio_income'          — dividends, interest, etc. (lands on a cash sleeve, optional related_holding_id)
--   'portfolio_expense'         — fees, withholding tax, margin interest paid, etc.
--
-- Non-portfolio rows (transactions without portfolio_holding_id) keep
-- `kind` NULL — the existing inference for non-portfolio rows continues
-- to work. After every active user is migrated and the new forms are live,
-- a follow-up migration could add NOT NULL + a CHECK that portfolio rows
-- always have kind set; not in scope here.

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS kind TEXT NULL
    CHECK (
      kind IS NULL OR kind IN (
        'buy', 'buy_cash_leg',
        'sell', 'sell_cash_leg',
        'in_kind_transfer_in', 'in_kind_transfer_out',
        'fx_from', 'fx_to', 'fx_fee',
        'portfolio_income', 'portfolio_expense'
      )
    );

-- Hot path: "show me every buy in 2025" / "show me every dividend in Q1
-- 2026". The kind column lives next to user_id + date in every dashboard
-- query, so the composite index pays off vs a single-column kind index.
CREATE INDEX IF NOT EXISTS transactions_user_kind_date_idx
  ON transactions (user_id, kind, date)
  WHERE kind IS NOT NULL;

-- ─── transactions.related_holding_id ─────────────────────────────────────
--
-- For portfolio_income / portfolio_expense rows that land on a cash
-- sleeve, this points back to the holding the income/expense pertains to.
-- Example: an AAPL dividend lands on the USD-cash sleeve (because cash is
-- where the dollars go), but `related_holding_id = AAPL.id` so reports
-- can group dividends by source holding.
--
-- Nullable: NULL is fine for income/expense that doesn't relate to a
-- specific holding (e.g., a margin-interest charge on the whole account,
-- or a non-portfolio transaction). FK CASCADE on holding delete so a
-- deleted AAPL holding nullifies the back-references rather than dragging
-- old dividend rows out from under the user.

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS related_holding_id INTEGER NULL
    REFERENCES portfolio_holdings(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS transactions_related_holding_idx
  ON transactions (related_holding_id)
  WHERE related_holding_id IS NOT NULL;

-- ─── portfolio_holdings.is_cash ──────────────────────────────────────────
--
-- Explicit flag for "this holding is a cash sleeve, not a tradeable
-- security." Today cash sleeves are detected by (symbol_ct IS NULL AND
-- name decodes to 'Cash') OR (symbol decodes to a currency code per
-- isCurrencyCodeSymbol). Both are inference; the new flag makes intent
-- first-class and lets the engine's link_id classifier discriminate
-- without per-call symbol decryption.
--
-- Cash sleeves carry currency in the existing `portfolio_holdings.currency`
-- plaintext column. The UI renders them as "Cash CAD" / "Cash USD" by
-- combining is_cash=TRUE + currency.

ALTER TABLE portfolio_holdings
  ADD COLUMN IF NOT EXISTS is_cash BOOLEAN NOT NULL DEFAULT FALSE;

-- Uniqueness invariant per user: at most one cash sleeve per (account,
-- currency). Enforced via partial unique index — non-cash holdings (the
-- vast majority) are unaffected. The migration's consolidation step below
-- merges existing duplicates before this index lands.
--
-- Note: account_id can be NULL on portfolio_holdings (legacy column;
-- holding_accounts is the M:N join). The partial index treats NULL
-- account_ids as distinct per Postgres semantics, which is acceptable —
-- unaccounted cash sleeves are an edge case.
CREATE UNIQUE INDEX IF NOT EXISTS portfolio_holdings_one_cash_per_account_currency
  ON portfolio_holdings (user_id, account_id, currency)
  WHERE is_cash = TRUE;

-- ─── Backfill: tag existing cash sleeves with is_cash = TRUE ─────────────
--
-- Detection: symbol_ct IS NULL matches every getOrCreateCashHolding
-- auto-created sleeve. Manual cash holdings using the
-- isCurrencyCodeSymbol pattern (symbol encrypted as "USD" / "CAD" / etc.)
-- are NOT caught here because we can't decrypt symbol in SQL — those
-- need a follow-up per-user normalization pass (operations.ts will
-- handle on-demand normalization when the user first interacts with
-- their portfolio).

UPDATE portfolio_holdings
   SET is_cash = TRUE
 WHERE symbol_ct IS NULL
   AND is_cash = FALSE;

-- ─── Consolidation: merge duplicate cash sleeves per (user, account, currency) ──
--
-- Some accounts may have multiple auto-created cash sleeves (e.g., from
-- pre-Stream-D migrations that double-created). For each (user, account,
-- currency) group with multiple cash sleeves: pick the survivor (oldest
-- by id), re-attribute every FK from duplicates to the survivor, delete
-- the duplicates. Idempotent.
--
-- FK chain that needs re-attribution:
--   transactions.portfolio_holding_id     → ON DELETE SET NULL (would null out, bad)
--   transactions.related_holding_id        → ON DELETE SET NULL
--   holding_accounts.holding_id            → ON DELETE CASCADE
--   holding_lots.holding_id                → ON DELETE CASCADE
--   portfolio_lots_status (no FK)
--   portfolio_snapshots is per-(user, account, date) and has no holding_id
--     column — no re-attribution needed there.
--
-- We must UPDATE the FK columns BEFORE the DELETE, otherwise CASCADE
-- destroys transaction history.

WITH ranked_cash AS (
  SELECT
    id,
    user_id,
    account_id,
    currency,
    ROW_NUMBER() OVER (
      PARTITION BY user_id, account_id, currency
      ORDER BY id ASC
    ) AS rn
  FROM portfolio_holdings
  WHERE is_cash = TRUE
),
survivors AS (
  SELECT user_id, account_id, currency, id AS survivor_id
  FROM ranked_cash WHERE rn = 1
),
duplicates AS (
  SELECT r.id AS dup_id, s.survivor_id
  FROM ranked_cash r
  JOIN survivors s
    ON r.user_id = s.user_id
   AND r.account_id IS NOT DISTINCT FROM s.account_id
   AND r.currency = s.currency
  WHERE r.rn > 1
)
-- Re-attribute transactions.portfolio_holding_id
UPDATE transactions t
   SET portfolio_holding_id = d.survivor_id
  FROM duplicates d
 WHERE t.portfolio_holding_id = d.dup_id;

WITH ranked_cash AS (
  SELECT
    id, user_id, account_id, currency,
    ROW_NUMBER() OVER (PARTITION BY user_id, account_id, currency ORDER BY id ASC) AS rn
  FROM portfolio_holdings WHERE is_cash = TRUE
),
survivors AS (SELECT user_id, account_id, currency, id AS survivor_id FROM ranked_cash WHERE rn = 1),
duplicates AS (
  SELECT r.id AS dup_id, s.survivor_id
  FROM ranked_cash r
  JOIN survivors s
    ON r.user_id = s.user_id AND r.account_id IS NOT DISTINCT FROM s.account_id AND r.currency = s.currency
  WHERE r.rn > 1
)
UPDATE transactions t
   SET related_holding_id = d.survivor_id
  FROM duplicates d
 WHERE t.related_holding_id = d.dup_id;

-- Re-attribute holding_accounts.holding_id — but the unique key on
-- (holding_id, account_id) might collide. We DELETE duplicate rows first
-- (where the survivor already has a (holding, account) pair) then UPDATE.
WITH ranked_cash AS (
  SELECT id, user_id, account_id, currency,
    ROW_NUMBER() OVER (PARTITION BY user_id, account_id, currency ORDER BY id ASC) AS rn
  FROM portfolio_holdings WHERE is_cash = TRUE
),
survivors AS (SELECT user_id, account_id, currency, id AS survivor_id FROM ranked_cash WHERE rn = 1),
duplicates AS (
  SELECT r.id AS dup_id, s.survivor_id
  FROM ranked_cash r JOIN survivors s
    ON r.user_id = s.user_id AND r.account_id IS NOT DISTINCT FROM s.account_id AND r.currency = s.currency
  WHERE r.rn > 1
)
DELETE FROM holding_accounts ha
 USING duplicates d
 WHERE ha.holding_id = d.dup_id
   AND EXISTS (
     SELECT 1 FROM holding_accounts ha2
      WHERE ha2.holding_id = d.survivor_id
        AND ha2.account_id = ha.account_id
   );

WITH ranked_cash AS (
  SELECT id, user_id, account_id, currency,
    ROW_NUMBER() OVER (PARTITION BY user_id, account_id, currency ORDER BY id ASC) AS rn
  FROM portfolio_holdings WHERE is_cash = TRUE
),
survivors AS (SELECT user_id, account_id, currency, id AS survivor_id FROM ranked_cash WHERE rn = 1),
duplicates AS (
  SELECT r.id AS dup_id, s.survivor_id
  FROM ranked_cash r JOIN survivors s
    ON r.user_id = s.user_id AND r.account_id IS NOT DISTINCT FROM s.account_id AND r.currency = s.currency
  WHERE r.rn > 1
)
UPDATE holding_accounts ha
   SET holding_id = d.survivor_id
  FROM duplicates d
 WHERE ha.holding_id = d.dup_id;

-- Re-attribute holding_lots.holding_id
WITH ranked_cash AS (
  SELECT id, user_id, account_id, currency,
    ROW_NUMBER() OVER (PARTITION BY user_id, account_id, currency ORDER BY id ASC) AS rn
  FROM portfolio_holdings WHERE is_cash = TRUE
),
survivors AS (SELECT user_id, account_id, currency, id AS survivor_id FROM ranked_cash WHERE rn = 1),
duplicates AS (
  SELECT r.id AS dup_id, s.survivor_id
  FROM ranked_cash r JOIN survivors s
    ON r.user_id = s.user_id AND r.account_id IS NOT DISTINCT FROM s.account_id AND r.currency = s.currency
  WHERE r.rn > 1
)
UPDATE holding_lots hl
   SET holding_id = d.survivor_id
  FROM duplicates d
 WHERE hl.holding_id = d.dup_id;

-- Now safe to delete the duplicate cash sleeve rows. CASCADE on FKs we've
-- already re-attributed is a no-op; CASCADE on rows we missed will
-- destroy them (defensive — there shouldn't be any).
WITH ranked_cash AS (
  SELECT id, user_id, account_id, currency,
    ROW_NUMBER() OVER (PARTITION BY user_id, account_id, currency ORDER BY id ASC) AS rn
  FROM portfolio_holdings WHERE is_cash = TRUE
)
DELETE FROM portfolio_holdings
 WHERE id IN (SELECT id FROM ranked_cash WHERE rn > 1);

-- ─── Backfill: tag existing portfolio rows with kind by qty sign ─────────
--
-- Per user decision 2026-05-23: keep migration simple.
--   qty > 0  → buy
--   qty < 0  → sell
--   qty = 0 (or NULL) with portfolio_holding_id set AND amount > 0 → portfolio_income
--   qty = 0 (or NULL) with portfolio_holding_id set AND amount < 0 → portfolio_expense
--   qty = 0 with amount = 0 → leave NULL
--
-- No attempt to detect transfers in historical data — link_id-paired rows
-- get tagged buy/sell by qty sign. The lot data (holding_lots.origin)
-- still preserves the transfer-in/out lineage; the discriminator on
-- transactions is the friendly UI tag, not the source of truth for
-- cost-basis math.

UPDATE transactions
   SET kind = CASE
     WHEN COALESCE(quantity, 0) > 0 THEN 'buy'
     WHEN COALESCE(quantity, 0) < 0 THEN 'sell'
     WHEN COALESCE(amount, 0) > 0 THEN 'portfolio_income'
     WHEN COALESCE(amount, 0) < 0 THEN 'portfolio_expense'
     ELSE NULL
   END
 WHERE portfolio_holding_id IS NOT NULL
   AND kind IS NULL;
