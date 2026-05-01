-- portfolio-canonical-names (2026-05-01) — Section F follow-on.
--
-- Per-user lazy canonicalization of portfolio_holdings display names. Rows
-- whose holding type is "tickered" / "cash sleeve" / "currency code" get
-- their `name` rewritten to the canonical key (uppercased symbol for
-- tickered rows, currency-derived name for cash/currency rows). Truly
-- user-defined positions (no symbol AND name != 'Cash' AND symbol not in
-- the supported-currency list) keep whatever the user typed.
--
-- The actual NULL+rewrite step is per-user because Stream D's `name_lookup`
-- is HMAC-derived from the user's DEK — SQL can't compute it without the
-- DEK in memory. This migration is the schema-only prep that adds the
-- `users.portfolio_names_canonicalized_at` flag column. The runtime helper
-- at src/lib/crypto/stream-d-canonicalize-portfolio.ts does the actual
-- per-row work on each successful login.
--
-- Idempotent — `ADD COLUMN IF NOT EXISTS`. Safe to re-run.
--
-- Apply order: prod → staging → dev. Run BEFORE deploying the matching
-- code so the helper has the column to read/write.
--
--   PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_prod    -d pf         -f scripts/migrate-portfolio-canonical-names.sql
--   PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_staging -d pf_staging -f scripts/migrate-portfolio-canonical-names.sql
--   PGPASSWORD='...' psql -h 127.0.0.1 -U finlynq_dev     -d pf_dev     -f scripts/migrate-portfolio-canonical-names.sql

BEGIN;

-- Per-user "canonicalization done" flag. NULL = needs canonicalization on
-- next login. Non-NULL = the user's portfolio_holdings rows have already
-- been pass through the canonicalization helper. ISO-text matches the rest
-- of the users table (last_login_at, created_at, plaintext_nulled_at).
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS portfolio_names_canonicalized_at text;

COMMIT;

-- Verification queries (run manually after deploy):
--   SELECT COUNT(*) FROM users WHERE portfolio_names_canonicalized_at IS NOT NULL;
--   -- starts at 0, climbs as users log in
--
--   SELECT id, username, portfolio_names_canonicalized_at FROM users
--     ORDER BY portfolio_names_canonicalized_at NULLS LAST;
