-- Migration: add ON DELETE CASCADE to transaction_splits.transaction_id
--
-- Without CASCADE, deleting a transaction that has splits fails with a
-- foreign-key violation — every delete path (web DELETE /api/transactions,
-- bulk delete, MCP delete_transaction, MCP execute_bulk_delete) returns 500
-- when hit against a transaction that has any split rows. Splits are a
-- dependent child of transactions and should disappear with the parent.
--
-- wipe-account already explicitly deletes splits first (queries.ts:284), so
-- account wipe is unaffected. Every other delete path relies on the FK.
--
-- Idempotent. Safe to re-run: the DO block only recreates the constraint if
-- it's currently defined without CASCADE.
--
--   PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_prod    -d pf         -f scripts/migrate-tx-splits-cascade.sql
--   PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_staging -d pf_staging -f scripts/migrate-tx-splits-cascade.sql
--   PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_dev     -d pf_dev     -f scripts/migrate-tx-splits-cascade.sql

BEGIN;

DO $$
DECLARE
  conname text;
  confdeltype "char";
BEGIN
  SELECT c.conname, c.confdeltype
    INTO conname, confdeltype
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_class r ON r.oid = c.confrelid
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
  WHERE c.contype = 'f'
    AND t.relname = 'transaction_splits'
    AND r.relname = 'transactions'
    AND a.attname = 'transaction_id';

  IF conname IS NULL THEN
    -- FK doesn't exist at all — create it with CASCADE.
    ALTER TABLE transaction_splits
      ADD CONSTRAINT transaction_splits_transaction_id_transactions_id_fk
      FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE;
  ELSIF confdeltype <> 'c' THEN
    -- Exists but not CASCADE (usually 'a' = NO ACTION). Drop + recreate.
    EXECUTE format('ALTER TABLE transaction_splits DROP CONSTRAINT %I', conname);
    EXECUTE format(
      'ALTER TABLE transaction_splits ADD CONSTRAINT %I FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE',
      conname
    );
  END IF;
END $$;

COMMIT;
