-- GH #464 (2026-11-27): the merchant category code in its own column.
--
-- SimpleFIN sends a card network merchant category code (ISO 18245, four
-- digits; 0000 = none) with many charges. It used to be stored as an
-- `mcc:<code>` tag, which cluttered the tag list and tag suggestions. It now
-- lives here, on the staged row, the bank-ledger row and the ledger
-- transaction. Plain text like fit_id / external_id: a four-digit code is not
-- sensitive, and it is matched as is by rules. Never part of import_hash.
--
-- Existing rows keep NULL. `mcc:` tags already on transactions are DEK
-- encrypted, so they can't be moved here in SQL: Settings -> Payees & tags
-- offers "Move merchant codes out of tags" for that.
--
-- Declared in src/db/schema-pg.ts too. No index: nothing filters by it in SQL.
-- The runner wraps the file in a transaction with the schema_migrations
-- bookkeeping insert, so there is no BEGIN/COMMIT here. Idempotent.

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS merchant_category_code text;
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS merchant_category_code text;
ALTER TABLE staged_transactions ADD COLUMN IF NOT EXISTS merchant_category_code text;
