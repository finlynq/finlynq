-- Index three foreign-key columns that every delete of their parent row scans
-- (2026-11-01, daily ops check).
--
-- Postgres does not index the referencing side of a foreign key. When a parent
-- row is deleted, the ON DELETE action looks up its children with
-- `WHERE <fk column> = $1`; with no index that is a full scan of the child
-- table, once per deleted parent row. Measured on prod:
--
--   staged_transactions.linked_transaction_id  -> transactions     (SET NULL)
--   staged_transactions.peer_staged_id         -> staged_transactions (self)
--   bank_transactions.original_staged_import_id -> staged_imports   (SET NULL)
--
-- Both child tables are ~55-58 MB, so a 50-row transaction delete took ~3 s,
-- discarding staged rows 2-11 s, deleting one staged import 15 s, and an
-- account wipe 13-40 s (21 slow deletes in diagnostics_log in 24 h).
--
-- Partial (IS NOT NULL), like idx_bank_transactions_upload_batch: the lookup
-- is always an equality on a non-null id, and most rows carry NULL in the two
-- staged_transactions columns.
--
-- Not CONCURRENTLY: the runner wraps the file in a transaction with the
-- schema_migrations bookkeeping insert. Building these takes about a second
-- on prod-sized tables. Additive + idempotent.

CREATE INDEX IF NOT EXISTS idx_staged_tx_linked_transaction
  ON staged_transactions (linked_transaction_id)
  WHERE linked_transaction_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_staged_tx_peer_staged
  ON staged_transactions (peer_staged_id)
  WHERE peer_staged_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bank_tx_original_staged_import
  ON bank_transactions (original_staged_import_id)
  WHERE original_staged_import_id IS NOT NULL;
