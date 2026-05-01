-- migrate-tx-audit-indexes.sql — Issue #59 (2026-04-30).
--
-- Composite indexes on the audit-trio columns added by issue #28
-- (`migrate-tx-audit-fields.sql`). These back the new "sort by Created /
-- Updated" headers on the /transactions table — without them, sorting by
-- `updated_at DESC` on a 50k+ tx data set table-scans every time.
--
-- `source` is a small-cardinality enum (7 values) — no index added; a
-- substring / equality filter on it is fast enough via the existing
-- `(user_id)` index even on large tables.
--
-- Idempotent. Safe to re-run. Run BEFORE the matching code deploy so the
-- indexes are in place when the new sort headers go live.

BEGIN;

CREATE INDEX IF NOT EXISTS transactions_user_updated_at_idx
  ON transactions (user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS transactions_user_created_at_idx
  ON transactions (user_id, created_at DESC);

COMMIT;
