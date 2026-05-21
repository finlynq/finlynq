-- Reconciliation-decision columns on staged_transactions + DB-side flags
-- table for the two-pane reconciliation UI (FINLYNQ-55, parent FINLYNQ-53).
--
-- Schema-only — the UI (F-53C), already-imported marker (F-53E), and
-- test-plan persistence assertion (F-53F) all read/write these columns.
-- Shipping the schema ahead of the UI lets each sub-item move independently
-- and avoids a code-FIRST-then-SQL conflict (CLAUDE.md migrations playbook).
--
-- Columns:
--   staged_transactions.reconcile_state TEXT NOT NULL DEFAULT 'unmatched'
--     CHECK over ('unmatched','auto_suggested','linked','skipped_duplicate').
--     Captures the user's reconciliation decision on the file-side staging
--     row. 'flagged_missing' is intentionally NOT a state here — DB-side
--     flags belong to transaction_reconciliation_flags (different lifecycle:
--     staging rows are ephemeral, flags persist past approval).
--   staged_transactions.linked_transaction_id INTEGER NULL
--     REFERENCES transactions(id) ON DELETE SET NULL.
--     Set when the user manually links a file row to an existing DB row.
--     transactions.id is serial(INTEGER), not UUID — the FK matches the PK
--     type. ON DELETE SET NULL so a transaction wipe doesn't cascade into
--     staging rows that the user may still want to re-link.
--
-- New table:
--   transaction_reconciliation_flags(id UUID PK, transaction_id INTEGER NN
--     REFERENCES transactions(id) ON DELETE CASCADE, user_id TEXT NN
--     REFERENCES users(id) ON DELETE CASCADE, flag_kind TEXT NN CHECK,
--     note TEXT NULL, created_at TIMESTAMPTZ NN DEFAULT NOW()).
--   Initial flag_kind: 'missing_from_statement'. CHECK guards the column
--   like the staged_transactions enum columns do.
--   Index on (user_id, transaction_id) for the per-user-per-tx lookup the
--   reconciliation pane runs as it iterates rows.
--
-- Pure additive: no DROP, no NOT NULL on existing rows without a default.
-- Existing staged_transactions rows take the column default ('unmatched')
-- and NULL linked_transaction_id automatically.
--
-- Idempotent: safe to re-run. The runner in deploy.sh wraps the file in a
-- transaction with the schema_migrations bookkeeping insert — do NOT add
-- a BEGIN/COMMIT block here.

-- ─── staged_transactions: reconciliation-decision columns ────────────────

ALTER TABLE staged_transactions
  ADD COLUMN IF NOT EXISTS reconcile_state TEXT NOT NULL DEFAULT 'unmatched',
  ADD COLUMN IF NOT EXISTS linked_transaction_id INTEGER;

-- linked_transaction_id FK — guard via pg_constraint since Postgres has no
-- ADD CONSTRAINT IF NOT EXISTS (mirrors 20260506_staging_unified_columns.sql).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'staged_transactions_linked_transaction_id_fkey'
  ) THEN
    ALTER TABLE staged_transactions
      ADD CONSTRAINT staged_transactions_linked_transaction_id_fkey
      FOREIGN KEY (linked_transaction_id) REFERENCES transactions(id)
      ON DELETE SET NULL;
  END IF;
END $$;

-- CHECK on reconcile_state — guard via pg_constraint.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'staged_transactions_reconcile_state_check'
  ) THEN
    ALTER TABLE staged_transactions
      ADD CONSTRAINT staged_transactions_reconcile_state_check
      CHECK (reconcile_state IN ('unmatched','auto_suggested','linked','skipped_duplicate'));
  END IF;
END $$;

-- ─── transaction_reconciliation_flags: DB-side annotations ───────────────

CREATE TABLE IF NOT EXISTS transaction_reconciliation_flags (
  id UUID PRIMARY KEY,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  flag_kind TEXT NOT NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'transaction_reconciliation_flags_flag_kind_check'
  ) THEN
    ALTER TABLE transaction_reconciliation_flags
      ADD CONSTRAINT transaction_reconciliation_flags_flag_kind_check
      CHECK (flag_kind IN ('missing_from_statement'));
  END IF;
END $$;

-- Reconciliation pane iterates per (user, transaction) — composite covers
-- the prefix-probe and surfaces every flag for one transaction in one read.
CREATE INDEX IF NOT EXISTS idx_tx_reconciliation_flags_user_tx
  ON transaction_reconciliation_flags (user_id, transaction_id);
