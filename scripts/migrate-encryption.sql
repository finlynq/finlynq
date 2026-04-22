-- Idempotent migration for envelope encryption (Phase 2).
--
-- Adds the DEK-envelope columns to the users table. Safe to run multiple
-- times — all ADD COLUMN statements are IF NOT EXISTS.
--
-- Usage (per environment):
--   PGPASSWORD="<db password>" psql -h 127.0.0.1 -U finlynq_prod    -d pf         -f scripts/migrate-encryption.sql
--   PGPASSWORD="<db password>" psql -h 127.0.0.1 -U finlynq_staging -d pf_staging -f scripts/migrate-encryption.sql
--   PGPASSWORD="<db password>" psql -h 127.0.0.1 -U finlynq_dev     -d pf_dev     -f scripts/migrate-encryption.sql
--
-- After this script runs, deploy the encryption-enabled app. Existing user
-- accounts will have NULL DEK columns; the login handler will generate their
-- DEK envelope on next successful password login (grace migration in
-- src/app/api/auth/login/route.ts).

BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS kek_salt         text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS dek_wrapped      text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS dek_wrapped_iv   text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS dek_wrapped_tag  text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS encryption_v     integer NOT NULL DEFAULT 1;

-- API keys don't need a schema change — the second DEK wrap is stored in
-- the existing `settings` table under key='api_key_dek' (value is base64
-- of iv||ciphertext||tag). Populated when a user creates/regenerates their
-- API key from the settings UI (must be logged in so we have the DEK).

COMMIT;

-- Verification query — run manually to confirm the schema is correct:
-- \d users
-- \d api_keys
