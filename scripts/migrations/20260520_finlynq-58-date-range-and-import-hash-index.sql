-- F-53E schema foundation (FINLYNQ-58, child FINLYNQ-76):
--
-- 1. `staged_imports.date_range_start` + `date_range_end` (TEXT, NULL)
--    Persist the period bounds of the parsed file so the overlapping-upload
--    merge prompt can detect overlap on a second upload to the same account
--    without re-parsing the original file. Distinct from the existing
--    `statement_period_start` / `statement_period_end` columns, which
--    capture the *statement's* declared period (set by OFX <DTSTART>/<DTEND>
--    when present); date_range_* captures the *transaction-row* span of
--    the actual parsed data and is therefore the truthful comparator for
--    overlap detection (a CSV with the wrong DTSTART would mis-fire). They
--    are populated identically today (both from min/max of row dates) but
--    the column split keeps the door open for divergence — and matches the
--    F-53E child item title verbatim.
--
--    Both nullable: pre-FINLYNQ-58 staged_imports rows take NULL; overlap
--    detection skips NULL rows (no overlap can be computed).
--
-- 2. `idx_transactions_user_import_hash` on `transactions(user_id, import_hash)`
--    Already-imported marker pass on every upload runs `SELECT EXISTS (...)`
--    against `transactions.import_hash` for ~100-1000 rows per batch; on a
--    multi-year transactions table this gets expensive without the index.
--    Composite `(user_id, import_hash)` rather than just `(import_hash)`
--    because every probe is user-scoped (cross-tenant FK risk per CLAUDE.md
--    "wipe-account is single-transaction + user_id-only filters"); the
--    partial-NULL exclusion makes the index ~½ the size when many rows
--    have NULL import_hash (manual entries, restored-from-backup rows).
--
-- Pure additive: no DROP, no NOT NULL on existing rows without a default.
-- Idempotent: safe to re-run. The runner in deploy.sh wraps the file in a
-- transaction with the schema_migrations bookkeeping insert — do NOT add
-- a BEGIN/COMMIT block here.

ALTER TABLE staged_imports
  ADD COLUMN IF NOT EXISTS date_range_start TEXT,
  ADD COLUMN IF NOT EXISTS date_range_end TEXT;

CREATE INDEX IF NOT EXISTS idx_transactions_user_import_hash
  ON transactions (user_id, import_hash)
  WHERE import_hash IS NOT NULL;
