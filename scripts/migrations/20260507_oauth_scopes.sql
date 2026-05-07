-- OAuth scope plumbing — Open #1 from SECURITY_HANDOVER_2026-05-07.md.
--
-- Adds `scope` to oauth_authorization_codes (carries scope from authorize
-- consent through to the token exchange) and oauth_access_tokens (the
-- claim the MCP route filters on).
--
-- Scope strings follow RFC 6749 §3.3 — space-separated tokens. Default
-- is 'mcp:read mcp:write' so existing OAuth clients keep their pre-PR
-- behavior (full read+write access to MCP). Future restrictions are
-- opt-in by clients passing a narrower `scope=mcp:read` on the authorize
-- redirect.
--
-- Recognized tokens at this PR:
--   mcp:read   — read-only MCP tools (get_*, list_*, search_*, ...)
--   mcp:write  — destructive / mutating MCP tools (record_*, update_*, ...)

ALTER TABLE oauth_authorization_codes
  ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'mcp:read mcp:write';

ALTER TABLE oauth_access_tokens
  ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'mcp:read mcp:write';
