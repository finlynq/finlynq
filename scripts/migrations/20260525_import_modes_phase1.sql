-- Import-modes refactor Phase 1 (plan/import-modes-simplified-detailed.md, 2026-05-25).
--
-- Schema-only migration. Zero behavior change at runtime — the new column on
-- import_templates defaults to 'detailed' so every existing template keeps the
-- legacy staged-review flow. The new bank_upload_batches table is empty until
-- Phase 2 wires the simplified-upload path; the new FK columns on
-- bank_transactions + bank_daily_balances are NULL on every pre-deploy row.
--
-- What this adds:
--
--   1. import_templates.import_mode TEXT NOT NULL DEFAULT 'detailed'
--        with CHECK (import_mode IN ('simplified','detailed'))
--      → per-template mode toggle. Simplified = land directly in
--        bank_transactions, skip staged review. Detailed = land in
--        staged_imports + staged_transactions, show parse on /import/pending.
--
--   2. bank_upload_batches (UUID PK)
--        lineage row for every upload batch (simplified-direct OR
--        detailed-via-approve). Anchors the Recent Uploads panel on
--        /reconcile and gives batch undo a clean handle. References
--        accounts(id), import_templates(id) (nullable), staged_imports(id)
--        (nullable — set only for detailed batches).
--
--   3. bank_transactions.upload_batch_id UUID NULL REFERENCES
--        bank_upload_batches(id) ON DELETE SET NULL
--      → batch lineage on the bank ledger. NULL for pre-Phase-1 rows
--        (acceptable — those rows just don't show up in the Recent Uploads
--        panel). ON DELETE SET NULL so a batch undo doesn't cascade-delete
--        the bank row (Phase 4's undo endpoint handles the cascade explicitly).
--
--   4. bank_daily_balances.upload_batch_id UUID NULL REFERENCES
--        bank_upload_batches(id) ON DELETE SET NULL
--      → same lineage on anchors. Lets batch undo also remove the anchors
--        that arrived with the batch (without affecting unrelated anchors
--        for that account).
--
-- Pure additive: no DROP, no NOT NULL on existing rows without a default.
-- Idempotent: safe to re-run. The runner in deploy.sh wraps the file in a
-- transaction with the schema_migrations bookkeeping insert — do NOT add
-- a BEGIN/COMMIT block here.

-- ─── 1. import_templates.import_mode ─────────────────────────────────────

ALTER TABLE import_templates
  ADD COLUMN IF NOT EXISTS import_mode TEXT NOT NULL DEFAULT 'detailed';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'import_templates_mode_check'
  ) THEN
    ALTER TABLE import_templates
      ADD CONSTRAINT import_templates_mode_check
      CHECK (import_mode IN ('simplified', 'detailed'));
  END IF;
END $$;

-- ─── 2. bank_upload_batches table ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bank_upload_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- NULL when the upload came from a path with no template (legacy email
  -- webhook, future connector calls that don't go through templates, etc.).
  template_id INTEGER REFERENCES import_templates(id) ON DELETE SET NULL,
  -- Provenance of the upload itself. 'upload' = user pasted/dropped a file
  -- on /import. 'email' = inbound webhook. 'connector' = automated pull.
  source TEXT NOT NULL,
  -- Which path the rows took to land in bank_transactions.
  --   'simplified' = upload route wrote bank_transactions directly.
  --   'detailed' = upload route wrote staged_imports + staged_transactions;
  --                approve route later materialized into bank_transactions.
  mode TEXT NOT NULL,
  -- Original filename (when applicable). NULL for connector pulls / email
  -- bodies without an attachment.
  filename TEXT,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Counts captured at write time. For detailed-mode batches the counts
  -- reflect what materialized at approve (excluding skipped duplicates).
  row_count INTEGER NOT NULL DEFAULT 0,
  anchor_count INTEGER NOT NULL DEFAULT 0,
  -- Detailed-mode lineage hint. NULL for simplified batches. Cleared (set
  -- NULL via ON DELETE SET NULL) if the staged_imports row is later TTL'd
  -- — the batch row outlives the staged metadata.
  staged_import_id TEXT REFERENCES staged_imports(id) ON DELETE SET NULL
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bank_upload_batches_source_check'
  ) THEN
    ALTER TABLE bank_upload_batches
      ADD CONSTRAINT bank_upload_batches_source_check
      CHECK (source IN ('upload', 'email', 'connector'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bank_upload_batches_mode_check'
  ) THEN
    ALTER TABLE bank_upload_batches
      ADD CONSTRAINT bank_upload_batches_mode_check
      CHECK (mode IN ('simplified', 'detailed'));
  END IF;
END $$;

-- Primary access path: "show me the last N batches for this account on
-- /reconcile". DESC because the Recent Uploads panel is reverse-chrono.
CREATE INDEX IF NOT EXISTS idx_bank_upload_batches_user_account_date
  ON bank_upload_batches (user_id, account_id, uploaded_at DESC);

-- ─── 3. bank_transactions.upload_batch_id ────────────────────────────────

ALTER TABLE bank_transactions
  ADD COLUMN IF NOT EXISTS upload_batch_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bank_transactions_upload_batch_id_fkey'
  ) THEN
    ALTER TABLE bank_transactions
      ADD CONSTRAINT bank_transactions_upload_batch_id_fkey
      FOREIGN KEY (upload_batch_id) REFERENCES bank_upload_batches(id)
      ON DELETE SET NULL;
  END IF;
END $$;

-- Partial index — most queries filter through (user, account, date) on the
-- bank_transactions side; the batch-id lookup is only used by the Recent
-- Uploads panel and by Phase 4's batch-undo endpoint, both of which know
-- the batch_id and walk the rows from there.
CREATE INDEX IF NOT EXISTS idx_bank_transactions_upload_batch
  ON bank_transactions (upload_batch_id)
  WHERE upload_batch_id IS NOT NULL;

-- ─── 4. bank_daily_balances.upload_batch_id ──────────────────────────────

ALTER TABLE bank_daily_balances
  ADD COLUMN IF NOT EXISTS upload_batch_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bank_daily_balances_upload_batch_id_fkey'
  ) THEN
    ALTER TABLE bank_daily_balances
      ADD CONSTRAINT bank_daily_balances_upload_batch_id_fkey
      FOREIGN KEY (upload_batch_id) REFERENCES bank_upload_batches(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_bank_daily_balances_upload_batch
  ON bank_daily_balances (upload_batch_id)
  WHERE upload_batch_id IS NOT NULL;
