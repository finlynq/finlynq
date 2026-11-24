-- GH #450 (2026-11-24): an external id on transactions.
--
-- A tool that records transactions from another system (an assistant pulling
-- card charges from a data provider, say) stores that system's id here so a
-- later run can tell the charge is already recorded, instead of putting the
-- id in the note. Plain text like fit_id: it is an opaque id from the other
-- system, and it has to be matched in SQL.
--
-- At most one transaction per account carries a given id. NULL (every
-- existing row, and every row recorded without one) is not limited.
--
-- Declared in src/db/schema-pg.ts too (schema-index parity test).
-- The runner wraps the file in a transaction with the schema_migrations
-- bookkeeping insert, so there is no BEGIN/COMMIT here. Idempotent.

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS external_id text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_transactions_external_id
  ON transactions (user_id, account_id, external_id)
  WHERE external_id IS NOT NULL;
