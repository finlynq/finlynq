-- FINLYNQ-12: convert transaction_rules.is_active from INTEGER to BOOLEAN.
--
-- The column has stored 0/1 since the initial schema; the new Drizzle column
-- definition is BOOLEAN. PostgreSQL requires an explicit USING clause to cast
-- INTEGER → BOOLEAN; `is_active::int <> 0` is safe whether the underlying
-- column is INTEGER (0/1 → false/true) or already BOOLEAN on a re-deploy
-- (BOOLEAN::int <> 0 round-trips identity).
--
-- Default flipped from 1 to TRUE in the same statement so freshly-inserted
-- rules continue to default to "active".
--
-- Code-side changes ship in the same commit (Drizzle schema + all read/write
-- callsites swept from `is_active = 1` / `: 1` to `= true` / `: true`).
-- Backup-restore coerces legacy 0/1 numeric values on import for back-compat
-- with pre-migration backups.
ALTER TABLE transaction_rules
  ALTER COLUMN is_active TYPE BOOLEAN USING (is_active::int <> 0),
  ALTER COLUMN is_active SET DEFAULT TRUE;
