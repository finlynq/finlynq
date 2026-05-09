-- Issue #211 (Bug d): align categories.type with the rest of the system
-- on 'R' for transfer (was 'T'). The MCP `create_category` tool exposed
-- type 'T' while transfer.ts, staged_transactions.tx_type CHECK,
-- bulk_record_transactions, and src/db/schema-pg.ts:txType all use 'R'.
-- 'T' rows persisted as orphans no other surface knew how to render.
--
-- Per the linked issue, only the auditor's `_TEST_TRANSFER_TYPE_T_` test
-- row is affected in practice; the UPDATE is idempotent (no-op when no
-- rows match) and safe to re-run.
--
-- No CHECK constraint is added in this migration — the existing schema
-- has none on `categories.type` and adding one would force a coordinated
-- code/SQL deploy. Application-layer enum tightening (this issue's
-- Phase 1 PR) is sufficient for the dev/prod populations today.

UPDATE categories SET type = 'R' WHERE type = 'T';
