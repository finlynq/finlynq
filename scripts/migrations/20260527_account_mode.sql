-- Reconcile v4 Phase 1 — per-account pipeline mode column
-- (plan/reconcile-v4-account-anchored-inbox.md, 2026-05-27).
--
-- Foundation for the upcoming /inbox surface. Every account picks the
-- pipeline policy that matches how much the user trusts the source:
--
--   'auto'    — Auto-pilot. Rules fire at upload, rows land in the
--               ledger immediately. Unmatched rows queue in
--               "To categorize."
--   'approve' — Approve-each. Bank-write is automatic; ledger commit
--               needs one click per row.
--   'manual'  — Manual review. Existing two-pane staging + reconcile
--               flow ('/import/pending' + '/reconcile'). Default for
--               every pre-Phase-1 account so behavior is unchanged
--               until the user opts in.
--
-- Pure additive: no DROP, default keeps every existing account on the
-- legacy flow. Idempotent: safe to re-run. The runner in deploy.sh
-- wraps the file in a transaction with the schema_migrations
-- bookkeeping insert — do NOT add a BEGIN/COMMIT block here.

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'manual';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'accounts_mode_check'
  ) THEN
    ALTER TABLE accounts
      ADD CONSTRAINT accounts_mode_check
      CHECK (mode IN ('auto', 'approve', 'manual'));
  END IF;
END $$;
