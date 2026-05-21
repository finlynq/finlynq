-- Parser knobs on the import upload UI (FINLYNQ-54).
--
-- Adds four persistent columns on `staged_imports` so the upload-step
-- preprocessor knobs survive the round-trip from form submission to the
-- review UI (F-53E merge flow needs to read them back). Knobs:
--
--   skip_header_rows       — INT >=0, default 0. Common on EU/ME bank
--                            exports that prepend title + metadata rows.
--   skip_footer_rows       — INT >=0, default 0. Strips summary/total rows
--                            at the bottom of the file.
--   date_format_override   — TEXT, NULLABLE. One of 'DD/MM/YYYY' /
--                            'MM/DD/YYYY' / 'YYYY-MM-DD' when set; NULL =
--                            parser auto-detect (default).
--   default_currency       — TEXT, NULLABLE. ISO 4217 / supportedCurrencyEnum.
--                            Applied to rows missing `entered_currency`.
--
-- A fifth knob ("default account") is **not new** — `bound_account_id` was
-- added in 20260506_staging_unified_columns.sql. This sub-item only unifies
-- the upload UX so the existing column is presented alongside the new ones.
--
-- Pure additive: no DROP, no NOT NULL on existing rows without a default.
-- Idempotent: safe to re-run. The runner in deploy.sh wraps the file in a
-- transaction with the schema_migrations bookkeeping insert — do NOT add
-- a BEGIN/COMMIT block here.

ALTER TABLE staged_imports
  ADD COLUMN IF NOT EXISTS skip_header_rows INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS skip_footer_rows INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS date_format_override TEXT,
  ADD COLUMN IF NOT EXISTS default_currency TEXT;

-- CHECK constraints — Postgres has no native ADD CONSTRAINT IF NOT EXISTS
-- for CHECK, so guard via pg_constraint (mirrors 20260506_staging_*.sql).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'staged_imports_skip_header_rows_check'
  ) THEN
    ALTER TABLE staged_imports
      ADD CONSTRAINT staged_imports_skip_header_rows_check
      CHECK (skip_header_rows >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'staged_imports_skip_footer_rows_check'
  ) THEN
    ALTER TABLE staged_imports
      ADD CONSTRAINT staged_imports_skip_footer_rows_check
      CHECK (skip_footer_rows >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'staged_imports_date_format_override_check'
  ) THEN
    ALTER TABLE staged_imports
      ADD CONSTRAINT staged_imports_date_format_override_check
      CHECK (date_format_override IS NULL OR date_format_override IN ('DD/MM/YYYY','MM/DD/YYYY','YYYY-MM-DD'));
  END IF;
END $$;
