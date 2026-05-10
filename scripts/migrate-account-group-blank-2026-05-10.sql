-- Issue #233 — backfill blank `group` on liability accounts to "Liability".
--
-- Pre-fix code wrote `${group ?? ""}` from MCP `add_account` and silently
-- accepted blank inputs from the REST `POST /api/accounts` schema, leaving
-- `accounts.group = ''` for an unknown number of liability rows. The cash-
-- flow forecast partition then surfaced these as `groupName: ""` because the
-- coalesce only handled NULL, not empty string.
--
-- Code-side fix shipped first (issue #233): both writers default `type='L'`
-- rows to `"Liability"` when `group` is missing/blank/whitespace-only, and
-- the MCP forecast trims the column before coalescing as belt-and-suspenders.
--
-- Run order (per CLAUDE.md "code FIRST, then SQL"):
--   1. Deploy the code fix (PR #234 / issue #233).
--   2. After verifying the new write path, run this SQL on each env: dev
--      first, prod second.
--
-- Idempotent: the WHERE clause excludes already-fixed rows. Safe to re-run.

BEGIN;

-- Note: `accounts` table has no `updated_at` column today. If/when one is
-- added, append `, updated_at = NOW()` to the SET clause.
UPDATE accounts
   SET "group" = 'Liability'
 WHERE type = 'L'
   AND ("group" IS NULL OR btrim("group") = '');

COMMIT;
