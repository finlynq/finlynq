-- FINLYNQ-167 — Admin OAuth-grants panel: per-grant last-used tracking.
-- Additive, NON-destructive: a nullable TIMESTAMPTZ on oauth_access_tokens,
-- bumped on each successful token validation (validateOauthToken in
-- src/lib/oauth.ts), throttled DB-side (UPDATE only when stale > 15 min) so it
-- is NOT a write per request — mirrors FINLYNQ-166's last_active_at throttle.
-- Drives the /admin OAuth-grants panel's last-used column + active/dormant flag
-- (dormant when last_used_at is NULL or > 60 days ago).
ALTER TABLE oauth_access_tokens ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;
