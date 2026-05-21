-- Webhooks schema (FINLYNQ-60 — parent FINLYNQ-43).
--
-- Foundation for the v1 webhook delivery surface. This sub-item is
-- schema-only; the worker (F-43B/FINLYNQ-61), the UI page (F-43D/FINLYNQ-63),
-- and the tx-write wiring (F-43C/FINLYNQ-62) all depend on these two tables
-- but ship separately. Spec lives in:
--   pf-app/docs/architecture/webhook-events.md (FINLYNQ-51 contract doc).
-- The CHECK list below MUST mirror that doc's v1 event vocabulary
-- (`transaction.created`, `transaction.updated`, `transaction.deleted`,
-- `transfer.created`, `import.approved`) — drift is a load-bearing breach.
--
-- New tables:
--
--   webhooks(
--     id UUID PK DEFAULT gen_random_uuid(),
--     user_id TEXT NN REFERENCES users(id) ON DELETE CASCADE,
--     url TEXT NN,
--     secret TEXT NN,           -- random >=32-char hex, server-generated on
--                                  insert, NEVER accepted from client. Stored
--                                  in plaintext on purpose: the delivery
--                                  worker fires async from background jobs
--                                  (cron, retry queue) where the user DEK
--                                  isn't in scope. The secret is a row-scoped
--                                  HMAC key, not user-derived data; rotation
--                                  is via revoke-and-recreate. Storing under
--                                  user DEK would break the worker.
--     event_filter TEXT[] NN,   -- elements constrained by CHECK to v1 set.
--     created_at TIMESTAMPTZ NN DEFAULT NOW(),
--     last_failed_at TIMESTAMPTZ NULL  -- surfaced as a warning dot in the
--                                          settings UI after a delivery's
--                                          retry budget runs out.
--   );
--
--   webhook_deliveries(
--     id UUID PK DEFAULT gen_random_uuid(),
--     webhook_id UUID NN REFERENCES webhooks(id) ON DELETE CASCADE,
--     event TEXT NN CHECK (event IN (...)),   -- same v1 enumeration.
--     payload_hash TEXT NN,     -- SHA-256 hex of the raw request body bytes
--                                  (NOT the HMAC signature). Lets the UI
--                                  display "delivered body fingerprint X"
--                                  without storing the body itself (PII
--                                  rule from webhook-events.md).
--     status_code INTEGER NULL, -- NULL = enqueued, not-yet-attempted.
--                                  >=200 / <300 = 2xx success. Negative
--                                  sentinel (-1) = exhausted retries per the
--                                  retry policy in webhook-events.md.
--     attempted_at TIMESTAMPTZ NN DEFAULT NOW()
--   );
--
-- Indexes:
--   webhooks (user_id) — list-all-webhooks-for-user.
--   webhooks (user_id, created_at DESC) — UI "recent first" sort.
--   webhook_deliveries (webhook_id, attempted_at DESC) — "recent deliveries"
--     pane on the settings UI iterates per webhook.
--
-- FK cascades:
--   webhooks.user_id -> users(id) ON DELETE CASCADE.
--   webhook_deliveries.webhook_id -> webhooks(id) ON DELETE CASCADE.
-- Both load-bearing for the wipe-account flow (CLAUDE.md "Wipe-account is
-- single-transaction + user_id-only filters") — deleting a user must clean
-- up webhook rows automatically without the wipe endpoint needing to know
-- about either table.
--
-- gen_random_uuid() is built-in to Postgres 13+ (no pgcrypto extension
-- required). Finlynq runs on Postgres 16.
--
-- Pure additive: no DROP, no NOT NULL on existing rows without a default.
-- Idempotent: safe to re-run. The runner in deploy.sh wraps the file in a
-- transaction with the schema_migrations bookkeeping insert — do NOT add
-- a BEGIN/COMMIT block here.

-- ─── webhooks ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS webhooks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  event_filter TEXT[] NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_failed_at TIMESTAMPTZ
);

-- CHECK on event_filter — every element must be in the v1 closed list.
-- Postgres has no ADD CONSTRAINT IF NOT EXISTS for CHECK, so guard via
-- pg_constraint lookup (mirrors 20260506_staging_unified_columns.sql).
-- The `<@` (is contained by) operator returns TRUE when every element of
-- the left array appears in the right; combined with the array_length
-- guard it rejects empty arrays too (an empty filter would never deliver,
-- which is almost certainly a UI bug).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'webhooks_event_filter_check'
  ) THEN
    ALTER TABLE webhooks
      ADD CONSTRAINT webhooks_event_filter_check
      CHECK (
        array_length(event_filter, 1) > 0
        AND event_filter <@ ARRAY[
          'transaction.created',
          'transaction.updated',
          'transaction.deleted',
          'transfer.created',
          'import.approved'
        ]::TEXT[]
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_webhooks_user_id
  ON webhooks (user_id);

CREATE INDEX IF NOT EXISTS idx_webhooks_user_id_created_at_desc
  ON webhooks (user_id, created_at DESC);

-- ─── webhook_deliveries ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id UUID NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status_code INTEGER,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Same v1 closed event list as the event_filter CHECK above. Drift between
-- the two is a contract breach with webhook-events.md.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'webhook_deliveries_event_check'
  ) THEN
    ALTER TABLE webhook_deliveries
      ADD CONSTRAINT webhook_deliveries_event_check
      CHECK (event IN (
        'transaction.created',
        'transaction.updated',
        'transaction.deleted',
        'transfer.created',
        'import.approved'
      ));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook_id_attempted_at_desc
  ON webhook_deliveries (webhook_id, attempted_at DESC);
