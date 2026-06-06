-- Email-import rule transforms (2026-06-16). Widens `email_import_rules` with
-- field mapping/transform knobs so a rule can fix a wrong sign, redirect the
-- recorded date, or rename a noisy payee — applied in the single materialize
-- path (recordEmailInboxRow) before the account-bound import_hash + ledger write.
--
-- Knobs:
--   flip_sign      — BOOLEAN, default FALSE. Multiply the parsed amount by -1
--                    (0 stays +0) for alerts that export expenses as positive.
--                    Plaintext (used by the record path, no secrecy value —
--                    same posture as match_type/mode).
--   date_source    — TEXT, default 'parsed'. 'parsed' = use the body-parsed date
--                    (today's behavior); 'received' = use the email received date
--                    (for alerts with no/wrong date in the body). Plaintext.
--   payee_override — TEXT, NULLABLE. A fixed payee to record regardless of how the
--                    alert phrases it. Free-text → user-DEK encrypted (v1:), like
--                    name/match_value (src/lib/email-rules/crypto.ts). No CHECK.
--
-- 'parsed' default keeps every existing rule behaving exactly as today.
--
-- Pure additive. Idempotent. The runner in deploy.sh wraps the file in a
-- transaction with the schema_migrations bookkeeping insert — do NOT add a
-- BEGIN/COMMIT block here.

ALTER TABLE email_import_rules
  ADD COLUMN IF NOT EXISTS flip_sign      BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS date_source    TEXT    NOT NULL DEFAULT 'parsed',
  ADD COLUMN IF NOT EXISTS payee_override TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'email_import_rules_date_source_check'
  ) THEN
    ALTER TABLE email_import_rules
      ADD CONSTRAINT email_import_rules_date_source_check
      CHECK (date_source IN ('parsed','received'));
  END IF;
END $$;
