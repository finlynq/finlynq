-- MCP idempotency keys (issue #98).
--
-- Caller-supplied retry safety for `bulk_record_transactions` (HTTP + stdio
-- MCP). First call with `idempotencyKey=K` inserts the transaction rows AND
-- stashes the response JSON here keyed by `(user_id, K)`. Any subsequent call
-- with the same `(user_id, K)` within 72h returns the stored `response_json`
-- verbatim — no INSERTs into `transactions`, no `invalidateUserTxCache` —
-- making the batch safe to retry on network timeouts without creating
-- duplicates.
--
-- Scoping: the UNIQUE index is on `(user_id, key)`, NOT `key` alone. A
-- different user reusing the same UUID is a legitimate independent batch,
-- not a collision. Tested by attempting Alice's key K from Bob's session
-- and confirming Bob's batch inserts normally.
--
-- TTL: a daily cron in `src/lib/cron/sweep-mcp-idempotency.ts` deletes rows
-- older than 72h via `DELETE ... WHERE created_at < NOW() - INTERVAL '72
-- hours'`. The `created_at` btree index supports the sweep.
--
-- Encryption: `response_json` is plaintext JSON in the DB. The writer in
-- `register-tools-pg.ts` (HTTP) redacts plaintext payee from per-row
-- `message` and account name from `resolvedAccount` BEFORE persisting, so
-- the at-rest blob does not regress Stream D's display-name encryption
-- contract. Replay returns the redacted message — the row ids are the
-- load-bearing part for the caller. See `pf-app/docs/architecture/mcp.md`
-- "Idempotency".
--
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS mcp_idempotency_keys (
  id            SERIAL PRIMARY KEY,
  user_id       TEXT NOT NULL,
  key           UUID NOT NULL,
  tool_name     TEXT NOT NULL,
  response_json JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS mcp_idempotency_keys_user_id_key_unique
  ON mcp_idempotency_keys (user_id, key);

CREATE INDEX IF NOT EXISTS mcp_idempotency_keys_created_at_idx
  ON mcp_idempotency_keys (created_at);
