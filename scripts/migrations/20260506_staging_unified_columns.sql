-- Unified-ingest columns for staging tables (issue #152, 2026-05-06).
--
-- The email-import staging tables (`staged_imports` + `staged_transactions`)
-- are about to become the single landing zone for every import source —
-- CSV/OFX/XLSX uploads, email attachments, future Plaid sync, and MCP
-- "park for later" requests. Today the tables only hold what email ingest
-- needs. This migration adds the columns that uploads, transfers, investment
-- trades, and the unified review UI all need.
--
-- Pure additive: no DROP, no NOT NULL on existing data without a default.
-- Existing rows keep working unchanged: tx_type='E', dedup_status='new',
-- row_status='pending', all other new columns NULL.
--
-- Idempotent: safe to re-run. The runner in deploy.sh wraps the file in a
-- transaction with the schema_migrations bookkeeping insert — do NOT add
-- a BEGIN/COMMIT block here.

-- ─── staged_imports — per-statement metadata ─────────────────────────────

ALTER TABLE staged_imports
  ADD COLUMN IF NOT EXISTS statement_balance DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS statement_balance_date TEXT,
  ADD COLUMN IF NOT EXISTS statement_currency TEXT,
  ADD COLUMN IF NOT EXISTS statement_period_start TEXT,
  ADD COLUMN IF NOT EXISTS statement_period_end TEXT,
  ADD COLUMN IF NOT EXISTS bound_account_id INTEGER REFERENCES accounts(id),
  ADD COLUMN IF NOT EXISTS file_format TEXT,
  ADD COLUMN IF NOT EXISTS original_filename TEXT;

-- ─── staged_transactions — full-transaction parity fields ────────────────

ALTER TABLE staged_transactions
  ADD COLUMN IF NOT EXISTS tx_type TEXT NOT NULL DEFAULT 'E',
  ADD COLUMN IF NOT EXISTS quantity DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS portfolio_holding_id INTEGER REFERENCES portfolio_holdings(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS entered_amount DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS entered_currency TEXT,
  ADD COLUMN IF NOT EXISTS tags TEXT,
  ADD COLUMN IF NOT EXISTS fit_id TEXT,
  ADD COLUMN IF NOT EXISTS peer_staged_id TEXT,
  ADD COLUMN IF NOT EXISTS target_account_id INTEGER REFERENCES accounts(id),
  ADD COLUMN IF NOT EXISTS dedup_status TEXT NOT NULL DEFAULT 'new',
  ADD COLUMN IF NOT EXISTS row_status TEXT NOT NULL DEFAULT 'pending';

-- peer_staged_id self-FK with DEFERRABLE INITIALLY DEFERRED so both legs
-- of a transfer pair can be inserted in the same transaction. ALTER TABLE
-- has no IF NOT EXISTS for ADD CONSTRAINT, so guard with pg_constraint.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'staged_transactions_peer_staged_id_fkey'
  ) THEN
    ALTER TABLE staged_transactions
      ADD CONSTRAINT staged_transactions_peer_staged_id_fkey
      FOREIGN KEY (peer_staged_id) REFERENCES staged_transactions(id)
      ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

-- CHECK constraints — Postgres has no native ADD CONSTRAINT IF NOT EXISTS
-- for CHECK, so guard via pg_constraint (mirrors 20260506_staging_encryption_tier.sql).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'staged_transactions_tx_type_check'
  ) THEN
    ALTER TABLE staged_transactions
      ADD CONSTRAINT staged_transactions_tx_type_check
      CHECK (tx_type IN ('E','I','R'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'staged_transactions_dedup_status_check'
  ) THEN
    ALTER TABLE staged_transactions
      ADD CONSTRAINT staged_transactions_dedup_status_check
      CHECK (dedup_status IN ('new','existing','probable_duplicate'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'staged_transactions_row_status_check'
  ) THEN
    ALTER TABLE staged_transactions
      ADD CONSTRAINT staged_transactions_row_status_check
      CHECK (row_status IN ('pending','approved','rejected'));
  END IF;
END $$;

-- ─── Indexes ─────────────────────────────────────────────────────────────

-- Review UI groups rows by dedup status within a single staged import.
CREATE INDEX IF NOT EXISTS idx_staged_tx_import_dedup
  ON staged_transactions (staged_import_id, dedup_status);

-- MCP list_staged_transactions filters per-user by row status.
CREATE INDEX IF NOT EXISTS idx_staged_tx_user_row_status
  ON staged_transactions (user_id, row_status);
