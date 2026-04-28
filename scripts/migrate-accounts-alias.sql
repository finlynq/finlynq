-- Accounts alias support — 2026-04-24
--
-- Adds a per-account short alias (e.g. "1234", "Visa4242") used by MCP
-- fuzzy account resolution and CSV import auto-mapping when a receipt
-- or bank export references the account by a non-canonical name.
--
-- Idempotent — `ADD COLUMN IF NOT EXISTS` skips on re-runs.

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS alias text;
