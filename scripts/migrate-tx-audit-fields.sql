-- migrate-tx-audit-fields.sql — Issue #28 (2026-04-30).
--
-- Adds three audit columns to transactions:
--   created_at — set on INSERT, never updated.
--   updated_at — set on INSERT and refreshed on every UPDATE.
--   source     — writer-surface attribution. Set on INSERT, never modified.
--                Allowed values: 'manual', 'import', 'mcp_http', 'mcp_stdio',
--                'connector', 'sample_data', 'backup_restore'. Enforced via
--                CHECK so unknown surfaces fail fast at write time.
--
-- These are system-time / system-attribution facts distinct from the user-
-- supplied `transactions.date`. Maintained at the application layer (no
-- triggers — matches the existing convention; every writer is centralized
-- through a small set of files and a coverage grep is cheap to run).
--
-- Note on entered_at vs created_at: entered_at (added 2026-04-27) is NOT a
-- substitute. It only fires on INSERT, is consumed by the FX-settlement cron's
-- date::date > entered_at::date heuristic, and we do NOT want to conflate it
-- with the new audit field. We deliberately do NOT use entered_at to backfill
-- created_at — semantics differ.
--
-- Pre-migration creation time + true source are unrecoverable. Backfill sets
-- both timestamps to NOW() and source to 'manual' (the safest default — it
-- understates imports / MCP rows but doesn't lie). A future analytics surface
-- aggregating by source must filter to created_at >= migration_timestamp.
--
-- Idempotent. Run BEFORE the matching code deploy so the new columns exist
-- when queries.ts/getTransactions starts SELECTing them.

BEGIN;

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS source     text        NOT NULL DEFAULT 'manual';

-- CHECK constraint: idempotent — drop the old one if present, then add fresh.
-- Allowed values are kept in sync with src/lib/tx-source.ts SOURCES tuple.
ALTER TABLE transactions
  DROP CONSTRAINT IF EXISTS transactions_source_check;

ALTER TABLE transactions
  ADD CONSTRAINT transactions_source_check
    CHECK (source IN ('manual', 'import', 'mcp_http', 'mcp_stdio', 'connector', 'sample_data', 'backup_restore'));

-- Defensive sweep — DEFAULT applied per-row at column-add time should make
-- this a no-op in the normal path, but a partial prior run might leave NULLs.
UPDATE transactions
   SET created_at = COALESCE(created_at, NOW()),
       updated_at = COALESCE(updated_at, NOW()),
       source     = COALESCE(NULLIF(source, ''), 'manual')
 WHERE created_at IS NULL OR updated_at IS NULL OR source IS NULL OR source = '';

COMMIT;
