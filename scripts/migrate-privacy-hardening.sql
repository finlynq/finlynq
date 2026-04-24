-- Privacy hardening migrations (Phase 1 + 2 + 4 of the Priority-One plan).
-- Idempotent — safe to re-run.
-- Apply on each env BEFORE deploying the privacy-hardening code.

-- ─── Finding #2 — OAuth: second DEK envelope wrapped with refresh_token ────
-- Used by refreshAccessToken() to carry the DEK forward when rotating the
-- pair. Without this, we'd need the old access-token plaintext (which we no
-- longer store) to unwrap the existing DEK envelope.
ALTER TABLE oauth_access_tokens
  ADD COLUMN IF NOT EXISTS dek_wrapped_refresh text;

-- ─── Finding #16 — admin_audit table ───────────────────────────────────────
-- Append-only record of admin mutations. Never UPDATE/DELETE via app code.
-- Consider a Postgres role with only INSERT on this table for the app user
-- as a future hardening step (not done in this migration to avoid schema
-- drift with existing ops tooling).
CREATE TABLE IF NOT EXISTS admin_audit (
  id            serial PRIMARY KEY,
  admin_user_id text NOT NULL REFERENCES users(id),
  target_user_id text REFERENCES users(id),
  action        text NOT NULL,
  before_json   text,
  after_json    text,
  ip            text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_audit_admin_user_id_idx
  ON admin_audit(admin_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS admin_audit_target_user_id_idx
  ON admin_audit(target_user_id, created_at DESC);

-- ─── Finding #2 — invalidate any existing OAuth tokens ─────────────────────
-- Token-format changed from plaintext to sha256-hash. Existing rows are now
-- unreachable (client can't present a matching token anymore). Explicit
-- revoke for cleanliness + forensic clarity. Safe with no users.
UPDATE oauth_access_tokens
   SET revoked_at = now()
 WHERE revoked_at IS NULL;

-- ─── Finding #2 — expire any in-flight authorization codes ─────────────────
-- Same reason — new format means old codes are unreachable.
DELETE FROM oauth_authorization_codes;

-- ─── Finding #10 — email verify tokens hashed at rest ──────────────────────
-- Existing unhashed tokens become unusable with the code change. Since no
-- users, just nuke them; new registrations will create fresh hashed tokens.
UPDATE users
   SET email_verify_token = NULL
 WHERE email_verify_token IS NOT NULL
   AND email_verified = 0;
