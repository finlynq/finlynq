-- Statement-upload field-mapping (2026-06-04).
--
-- Two per-account import preferences, both seeded by a per-user default
-- (§B's user-level setting lives in the `settings` key/value table as
-- `confirm_csv_mapping`; §A has no separate user-level setting — its
-- per-user default IS this column default 'name').
--
--   ofx_payee_source — which OFX/QFX field populates the canonical `payee`
--     column for bank/CC <STMTTRN> rows.
--       'name' (default = today's behavior: NAME→payee, MEMO→note)
--       'memo' (flip: MEMO→payee, NAME→note — for banks that bury the
--               merchant string in <MEMO> and put a generic type label in
--               <NAME>).
--     Default 'name' preserves the pre-2026-06-04 NAME-first behavior, so
--     no existing account changes. Investment statements ignore this knob.
--
--   csv_mapping_mode — whether a CSV upload's auto-detected column mapping
--     is confirmed before staging.
--       'confirm' (default = the new safe behavior: show the detected
--                  mapping for one-click review/edit before rows land)
--       'auto'    (silent auto-apply, today's pre-2026-06-04 behavior).
--     NOTE: the default is 'confirm', which DOES change behavior for
--     existing accounts (a one-time re-prompt the next time a CSV is
--     uploaded to the account). This is the intended product decision —
--     the upload pipeline should never silently pick a column mapping the
--     user can't see/veto. A user who trusts the auto-detect flips the
--     account (or the global Settings → Import switch) back to 'auto'.
--
-- Pure additive: no DROP. Idempotent: safe to re-run. The runner in
-- deploy.sh wraps the file in a transaction with the schema_migrations
-- bookkeeping insert — do NOT add a BEGIN/COMMIT block here.

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS ofx_payee_source TEXT NOT NULL DEFAULT 'name';

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS csv_mapping_mode TEXT NOT NULL DEFAULT 'confirm';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'accounts_ofx_payee_source_check'
  ) THEN
    ALTER TABLE accounts
      ADD CONSTRAINT accounts_ofx_payee_source_check
      CHECK (ofx_payee_source IN ('name', 'memo'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'accounts_csv_mapping_mode_check'
  ) THEN
    ALTER TABLE accounts
      ADD CONSTRAINT accounts_csv_mapping_mode_check
      CHECK (csv_mapping_mode IN ('confirm', 'auto'));
  END IF;
END $$;
