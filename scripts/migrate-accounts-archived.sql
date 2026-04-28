-- Accounts archive/hide support — 2026-04-24
--
-- Adds an `archived` boolean to `accounts` so users can hide accounts they
-- no longer use without deleting history. Archived accounts are filtered
-- out of balances, dashboards, pickers, and FX conversions by default; a
-- "Show archived" toggle on the accounts page brings them back for editing
-- or un-archiving.
--
-- Idempotent — `ADD COLUMN IF NOT EXISTS` skips on re-runs.

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS archived boolean NOT NULL DEFAULT false;
