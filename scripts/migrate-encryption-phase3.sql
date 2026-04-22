-- Phase 3 encryption migration — add DEK-envelope columns to OAuth tables
-- and extend the settings table with a webhook-DEK wrap entry (stored as a
-- regular row under key='email_webhook_dek' — no schema change needed there).
--
-- Idempotent: all ADD COLUMNs are IF NOT EXISTS. Safe to re-run.
--
-- Usage (per environment):
--   PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_prod    -d pf         -f scripts/migrate-encryption-phase3.sql
--   PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_staging -d pf_staging -f scripts/migrate-encryption-phase3.sql
--   PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_dev     -d pf_dev     -f scripts/migrate-encryption-phase3.sql

BEGIN;

-- OAuth authorization codes hold a DEK wrap for the few minutes between
-- "user clicks Allow" and "client exchanges the code at /api/oauth/token".
-- Wrap key is SHA-256(auth_code).
ALTER TABLE oauth_authorization_codes
  ADD COLUMN IF NOT EXISTS dek_wrapped text;

-- OAuth access tokens hold a DEK wrap for the token's lifetime (1h for
-- access, 30d for refresh). Wrap key is SHA-256(access_token).
ALTER TABLE oauth_access_tokens
  ADD COLUMN IF NOT EXISTS dek_wrapped text;

COMMIT;
