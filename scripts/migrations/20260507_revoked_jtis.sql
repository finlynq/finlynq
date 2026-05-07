-- Revoked JWT jti tracking (B7, 2026-05-07).
--
-- Server-side JWT denylist. A token's `jti` lands here when:
--   1. The user calls /api/auth/logout — invalidates the cookie immediately
--      so a stolen cookie can't keep accessing plaintext-only routes after
--      the user clicked sign-out (H-5).
--   2. /api/auth/mfa/verify successfully promotes a pending token — the old
--      pending token's jti is denylisted so a captured pending-token cookie
--      can't be replayed against /mfa/verify with a different code (H-4).
--
-- The auth path queries this table on every request via a 30s in-process
-- cache to keep the hot path snappy. `expires_at` is the original JWT exp
-- so the table can be vacuumed by a daily cron — keeping a row past its
-- exp is safe but wasteful (the JWT signature would already be expired).
--
-- Idempotent. The runner in deploy.sh wraps the file in a single
-- transaction with the schema_migrations bookkeeping insert — do NOT
-- add a BEGIN/COMMIT block here.

CREATE TABLE IF NOT EXISTS revoked_jtis (
  jti TEXT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS revoked_jtis_expires_at_idx ON revoked_jtis(expires_at);
