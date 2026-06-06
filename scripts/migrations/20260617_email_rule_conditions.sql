-- Email-import rule multi-conditions (2026-06-17). Widens `email_import_rules`
-- from a single flat (match_type/match_op/match_value) match to an AND-only
-- group of typed conditions in a JSONB column.
--
--   conditions  JSONB  — { "all": [ { field, op, value } | { field:"amount", op:"between", min, max } ] }
--                        AND-only. Text-field string values are user-DEK
--                        encrypted (v1:), like match_value; numeric amount
--                        thresholds stay plaintext. NULL ⇒ read the flat
--                        (match_type/op/value) fallback (pre-migration rows).
--
-- `conditions` is the source of truth going forward; the flat columns are a
-- FROZEN back-compat fallback, read only when `conditions IS NULL`. A
-- `body`/`payee`/`amount` condition cannot be represented in the flat
-- match_type CHECK (`IN ('sender','subject')`) — which is exactly why the write
-- path stops populating the flat columns and always normalizes to `conditions`.
--
-- Pure additive. Idempotent. The runner in deploy.sh wraps the file in a
-- transaction + the schema_migrations insert — do NOT add a BEGIN/COMMIT block.

ALTER TABLE email_import_rules
  ADD COLUMN IF NOT EXISTS conditions JSONB;

-- Backfill existing single-condition rules into a 1-element group. The encrypted
-- match_value ciphertext moves VERBATIM into the condition value (the read-path
-- crypto walker decrypts it; sender/subject are STRING_FIELDS).
UPDATE email_import_rules
SET conditions = jsonb_build_object(
      'all',
      jsonb_build_array(
        jsonb_build_object('field', match_type, 'op', match_op, 'value', match_value)
      )
    )
WHERE conditions IS NULL
  AND match_type IS NOT NULL
  AND match_op IS NOT NULL
  AND match_value IS NOT NULL;

-- Conditions-only rows omit the flat tri. The match_type CHECK IN ('sender',
-- 'subject') is satisfied by NULL in Postgres, so it stays as-is.
ALTER TABLE email_import_rules ALTER COLUMN match_type  DROP NOT NULL;
ALTER TABLE email_import_rules ALTER COLUMN match_op    DROP NOT NULL;
ALTER TABLE email_import_rules ALTER COLUMN match_value DROP NOT NULL;
