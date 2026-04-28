-- OAuth hygiene (V2 Stream C) — 2026-04-23
--
-- Adds a `revoked_at` column to `oauth_access_tokens` so refresh-token reuse
-- can be detected. On refresh, the old row is marked `revoked_at = now()`
-- (rather than deleted). On the next attempted use of that refresh token,
-- we distinguish:
--   (a) row missing entirely → never existed, return 401 invalid_grant
--   (b) row exists with revoked_at IS NOT NULL → token-theft signal,
--       invalidate every live access token for that user + return 401.
--
-- Idempotent — `ADD COLUMN IF NOT EXISTS` skips on re-runs.

ALTER TABLE oauth_access_tokens
  ADD COLUMN IF NOT EXISTS revoked_at timestamp with time zone;

-- Cleanup index: we only want "live" tokens at validation time, so a partial
-- index on (token) WHERE revoked_at IS NULL keeps lookups fast as old rows
-- accumulate. The primary token-uniqueness constraint stays on the full set
-- so a revoked token can't be issued again by chance.
CREATE INDEX IF NOT EXISTS idx_oauth_access_tokens_live
  ON oauth_access_tokens (token)
  WHERE revoked_at IS NULL;
