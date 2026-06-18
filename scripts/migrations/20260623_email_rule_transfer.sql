-- FINLYNQ-189 — Email-import rules: record a transfer (not just a category/expense).
--
-- Email alerts about internal money movement ("You transferred $X to Savings",
-- credit-card payment confirmations) were the user's only lever a category, so
-- they booked as a categorized EXPENSE instead of a TRANSFER — wrong sign /
-- double-counts in flow reports. This column lets a rule record a transfer from
-- the rule's account (the OUTFLOW/source leg) to a destination account (the
-- INFLOW leg) via the canonical web transfer write path (resolveTransferCategoryId
-- → the "Transfer" category, FINLYNQ-131; one server-generated link_id).
--
--   NULL    ⇒ category/expense mode (today's behavior, unchanged).
--   <acct>  ⇒ transfer mode: record a paired transfer, account → this dest.
--             `category_id` is ignored (mutually exclusive at the editor + record
--             path). v1 is SAME-CURRENCY only — the record path refuses a
--             cross-currency source/dest pair (mirrors the web transfer refusal).
--
-- FK style: matches the existing account_id reference TARGET (accounts.id) but
-- uses ON DELETE SET NULL — this column is NULLABLE/optional (like category_id),
-- so deleting the destination account should CLEAR the destination (the rule
-- degrades to category mode), NOT cascade-delete the whole rule the way the
-- NOT-NULL source account_id (ON DELETE CASCADE) does.
--
-- Additive, NON-destructive. Idempotent. No backfill — existing rows read NULL
-- and stay in category/expense mode. The runner in deploy.sh wraps the file in a
-- transaction + the schema_migrations insert — do NOT add a BEGIN/COMMIT block.

ALTER TABLE email_import_rules
  ADD COLUMN IF NOT EXISTS transfer_dest_account_id INTEGER
    REFERENCES accounts (id) ON DELETE SET NULL;
