-- FINLYNQ-12: convert transaction_rules.is_active from INTEGER to BOOLEAN.
--
-- The column has stored 0/1 since the initial schema; the new Drizzle column
-- definition is BOOLEAN. PostgreSQL requires an explicit USING clause to cast
-- INTEGER -> BOOLEAN; `is_active::int <> 0` is safe whether the underlying
-- column is INTEGER (0/1 -> false/true) or already BOOLEAN on a re-deploy
-- (BOOLEAN::int <> 0 round-trips identity).
--
-- Order matters:
--   1. DROP the existing DEFAULT (integer 1) — PostgreSQL evaluates the
--      stored default against the new column type BEFORE applying any new
--      default, so the cast fails with "default for column cannot be cast
--      automatically to type boolean" if we leave it in place.
--   2. Change the column type via USING.
--   3. SET the new BOOLEAN default.
--   4. Re-assert NOT NULL (it was already NOT NULL; this is a defense-in-depth
--      no-op since SET NOT NULL is idempotent).
--
-- Code-side changes ship in the same commit (Drizzle schema + all read/write
-- callsites swept from `is_active = 1` / `: 1` to `= true` / `: true`).
-- Backup-restore coerces legacy 0/1 numeric values on import for back-compat
-- with pre-migration backups.
ALTER TABLE transaction_rules ALTER COLUMN is_active DROP DEFAULT;
ALTER TABLE transaction_rules
  ALTER COLUMN is_active TYPE BOOLEAN USING (is_active::int <> 0);
ALTER TABLE transaction_rules ALTER COLUMN is_active SET DEFAULT TRUE;
ALTER TABLE transaction_rules ALTER COLUMN is_active SET NOT NULL;
