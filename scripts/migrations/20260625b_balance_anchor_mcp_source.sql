-- FINLYNQ-217 (R-03) — allow a new balance-anchor source 'mcp_manual'.
--
-- The MCP upsert_balance_anchor tool lets Claude create/correct a bank balance
-- anchor outside the staged-import flow. Such anchors carry source='mcp_manual',
-- which must be added to the bank_daily_balances source CHECK (kept in sync with
-- the ANCHOR_SOURCES tuple in src/lib/bank-ledger-balance.ts).
--
-- ADDITIVE: this only WIDENS the allowed source set — every existing row already
-- satisfies the new constraint, so it is safe to auto-apply on deploy. Idempotent
-- via DROP CONSTRAINT IF EXISTS. The constraint name (bank_daily_balances_source_check)
-- matches the deployed schema exactly.
ALTER TABLE bank_daily_balances DROP CONSTRAINT IF EXISTS bank_daily_balances_source_check;
ALTER TABLE bank_daily_balances ADD CONSTRAINT bank_daily_balances_source_check
  CHECK (source IN ('csv_column','ofx_ledgerbal','upload_form','email','connector','backup_restore','mcp_manual'));
