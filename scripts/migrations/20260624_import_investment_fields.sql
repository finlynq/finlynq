-- FINLYNQ-195 — Import: ticker/symbol + security name + quantity mapping for
-- investment accounts (v1, staging capture only).
--
-- When the import target is an investment account, a brokerage/holdings CSV
-- export carries columns the cash-account schema couldn't hold: the security
-- TICKER/SYMBOL and the security NAME (the QUANTITY column already exists on
-- both staging tables — `quantity`). This migration adds the two new free-text
-- columns to BOTH staging ledgers so the mapped values round-trip from the
-- column mapper → preview → staging → bank_transactions.
--
-- v1 SCOPE (deliberately narrow per the user decision 2026-06-18): rows are
-- CAPTURED into staging / bank_transactions only. v1 does NOT materialize
-- lot-aware portfolio operations (no +stock/−cash legs, no resolveOrCreateSecurity)
-- — that's the deferred follow-up. Nothing reads these columns into
-- `transactions` for an investment account (which would violate the
-- `is_investment ⇒ portfolio_holdings` constraint).
--
-- ENCRYPTION: `ticker` and `security_name` are SENSITIVE free-text crossing
-- into the staging ledgers, so they are encrypted-in-place under the row's
-- existing two-tier scheme (v1: user-DEK / sv1: PF_STAGING_KEY), exactly like
-- the sibling `payee` / `note` / `tags` columns. Read paths branch per-row on
-- `encryption_tier`. They are plain TEXT columns here — the envelope prefix is
-- carried in the value, identical to the other encrypted text columns.
--
-- Additive, NON-destructive, idempotent. No backfill — existing rows read NULL.
-- The runner in deploy.sh wraps the file in a transaction + the
-- schema_migrations insert — do NOT add a BEGIN/COMMIT block.

ALTER TABLE bank_transactions
  ADD COLUMN IF NOT EXISTS ticker TEXT,
  ADD COLUMN IF NOT EXISTS security_name TEXT;

ALTER TABLE staged_transactions
  ADD COLUMN IF NOT EXISTS ticker TEXT,
  ADD COLUMN IF NOT EXISTS security_name TEXT;
