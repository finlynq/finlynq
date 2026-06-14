-- FINLYNQ-166 — Admin: per-user last-active tracking (dormancy).
-- Additive, NON-destructive: a nullable TIMESTAMPTZ bumped on ANY authenticated
-- access (web session, OAuth/MCP token validation, pf_ API-key). Unlike
-- last_login_at (web password logins only), this captures MCP-only / API-key-only
-- users so the admin "Last active" column can answer "who is dormant vs active".
-- The bump is throttled DB-side (UPDATE only when stale > 15 min) so it is not a
-- write per request — see src/lib/auth/last-active.ts.
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ;
