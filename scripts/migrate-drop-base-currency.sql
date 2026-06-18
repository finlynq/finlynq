-- FINLYNQ-183 — DROP COLUMN users.base_currency.
--
-- The app converged on a SINGLE user-facing currency. `settings.display_currency`
-- is now the one currency the whole app reports in AND the realized-gain
-- accounting basis; the former `users.base_currency` was a USD-locked orphan
-- with no UI, no API, and a single live reader (the realized-gains base toggle).
-- That reader now resolves the display currency instead, so the column carries
-- no value worth keeping.
--
-- NO DATA MIGRATION NEEDED: `realizedGainInBase` is computed live per request
-- from historical FX snapshots (augmentWithBaseCurrency), never persisted. The
-- column held only the default 'USD' for every user, so dropping it loses
-- nothing.
--
-- LOOSE PATH — this file is NOT under scripts/migrations/ and is NOT run by
-- deploy.sh. It is applied MANUALLY by the operator, AFTER the matching code
-- release is deployed, per docs/migrations.md (plan/migrations.md). DROP COLUMN
-- is backwards-incompatible only with code that SELECTs the column; the new
-- release no longer references users.base_currency (Drizzle selects explicit
-- columns), so:
--
--   ORDER OF OPERATIONS — code FIRST, then this SQL.
--     1. Deploy the FINLYNQ-183 code release (schema without base_currency).
--     2. Run this migration:  psql "$PF_DATABASE_URL" -f scripts/migrate-drop-base-currency.sql
--
-- The gap between (1) and (2) is safe: the column still physically exists with
-- its NOT NULL DEFAULT 'USD', so any insert during the window is covered.
--
-- Idempotent — re-running on a column-already-dropped DB is a no-op via IF EXISTS.

BEGIN;

ALTER TABLE users DROP COLUMN IF EXISTS base_currency;

COMMIT;

-- Post-migration verification:
--   \d users
--   -- column "base_currency" should no longer appear
