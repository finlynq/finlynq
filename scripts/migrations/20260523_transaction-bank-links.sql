-- Reconcile page: transaction_bank_links many-to-many table (2026-05-23).
--
-- The 2026-05-22 two-ledger refactor added a 1:1 lineage FK
-- `transactions.bank_transaction_id`. This migration lifts that to M:N in
-- both directions so the standalone /reconcile page can express:
--   - 1 bank row → N transactions  (one bank charge split into multiple
--     system-side transactions because the user tracks them separately)
--   - N bank rows → 1 transaction  (a recurring fee spread across statements
--     that the user wants to track as a single annual line)
--
-- The existing FK `transactions.bank_transaction_id` stays. Every primary
-- join row mirrors it. Aggregators / wipe-account / backup-restore that
-- already read the FK keep working unchanged; the join table is consulted
-- only when the caller wants the full link set.
--
-- CASCADE on both FKs:
--   - Deleting a transaction removes its join rows (the bank row persists).
--   - Deleting a bank row removes its join rows (the existing
--     `transactions.bank_transaction_id` ON DELETE SET NULL rule independently
--     handles the FK side).
-- Net: wipe-account's existing "delete transactions THEN bank_transactions"
-- ordering keeps working without modification.
--
-- Also extends the `transactions.source` CHECK constraint with the new
-- `'reconcile_link'` writer-surface label used by the
-- /api/reconcile/materialize endpoint (Phase 2). Mirrors the SOURCES tuple
-- in src/lib/tx-source.ts.
--
-- Pure additive: no DROP COLUMN, no NOT NULL on existing rows without a
-- default, no behavior change for paths that don't yet read the join
-- table. The runner in deploy.sh wraps the file in a transaction with the
-- schema_migrations bookkeeping insert — do NOT add a BEGIN/COMMIT block here.

-- ─── transaction_bank_links table ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS transaction_bank_links (
  id                  SERIAL PRIMARY KEY,
  user_id             TEXT    NOT NULL,
  transaction_id      INTEGER NOT NULL REFERENCES transactions(id)      ON DELETE CASCADE,
  bank_transaction_id UUID    NOT NULL REFERENCES bank_transactions(id) ON DELETE CASCADE,
  -- 'primary' | 'extra'. Application-layer invariant: exactly one 'primary'
  -- per transaction at a time, mirrored on transactions.bank_transaction_id.
  -- Not enforced by SQL CHECK in v1 (rules-v2 precedent — drift between
  -- code enum and SQL CHECK is a CLAUDE.md contract breach unless documented).
  link_type           TEXT    NOT NULL DEFAULT 'extra',
  -- Writer-surface attribution. Mirrors the SOURCES tuple in
  -- src/lib/tx-source.ts. Today's writers: 'manual' (user clicked Accept),
  -- 'import' (backfilled below + Phase 5 dual-write retrofit),
  -- 'reconcile_link' (materialize-from-bank-row), 'backup_restore'.
  source              TEXT    NOT NULL DEFAULT 'manual',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A given (tx, bank) pair links at most once, regardless of link_type.
CREATE UNIQUE INDEX IF NOT EXISTS transaction_bank_links_pair_uq
  ON transaction_bank_links (transaction_id, bank_transaction_id);

-- Hot paths for the suggestions endpoint: "give me every link for these
-- tx ids" / "give me every link for these bank ids".
CREATE INDEX IF NOT EXISTS transaction_bank_links_user_tx_idx
  ON transaction_bank_links (user_id, transaction_id);
CREATE INDEX IF NOT EXISTS transaction_bank_links_user_bank_idx
  ON transaction_bank_links (user_id, bank_transaction_id);

-- ─── transactions.source CHECK — append 'reconcile_link' ────────────────
--
-- Idempotent — drop the old constraint if present, then add fresh. Mirrors
-- the pattern in scripts/migrate-tx-audit-fields.sql.
ALTER TABLE transactions
  DROP CONSTRAINT IF EXISTS transactions_source_check;

ALTER TABLE transactions
  ADD CONSTRAINT transactions_source_check
    CHECK (source IN ('manual', 'import', 'mcp_http', 'mcp_stdio',
                      'connector', 'sample_data', 'backup_restore',
                      'reconcile_link'));

-- ─── Backfill: existing FK-set transactions → primary join rows ─────────
--
-- Every transaction with a non-NULL bank_transaction_id today becomes a
-- 'primary' join row tagged source='import' (the migration's surface, since
-- pre-Phase-5 the only path that sets the FK is the import chokepoints).
-- Idempotent — ON CONFLICT DO NOTHING handles re-runs and skips rows already
-- inserted by a partial prior run or by post-migration dual-writes.
--
-- Future-proofing: this backfill MUST run AFTER the CREATE TABLE above. The
-- DO NOTHING also protects against the rare race where a brand-new INSERT
-- from a dual-write retrofit beats the migration on a deploy that's mid-flight.
INSERT INTO transaction_bank_links
  (user_id, transaction_id, bank_transaction_id, link_type, source, created_at)
SELECT
  t.user_id,
  t.id,
  t.bank_transaction_id,
  'primary',
  'import',
  NOW()
FROM transactions t
WHERE t.bank_transaction_id IS NOT NULL
ON CONFLICT (transaction_id, bank_transaction_id) DO NOTHING;
