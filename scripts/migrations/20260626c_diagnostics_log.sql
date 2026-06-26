-- Operator diagnostics log — persistent slow-query / error capture.
--
-- Backs the /admin/diagnostics view: persists slow DB queries
-- (>= PF_SLOW_QUERY_MS, default 2000ms), DB errors, API 5xx errors, and outbound
-- market-data provider failures so the last N entries survive a deploy/restart
-- (the marketFetch + sys-metrics buffers are in-memory and reset on restart).
--
-- Global + plaintext, NOT per-user (like price_cache / announcements): no user_id,
-- no DEK, and NOT in the per-user wipe/delete path. Free-text (SQL text / error
-- messages / URLs) is run through scrubSensitive before insert. The table is
-- capped + trimmed to the newest PF_DIAGNOSTICS_CAP rows (default 5000) by the
-- app, so it never grows unbounded.
--
-- Additive + idempotent. Auto-applied by deploy.sh (tracked migration).

CREATE TABLE IF NOT EXISTS diagnostics_log (
  id          SERIAL PRIMARY KEY,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind        TEXT NOT NULL,        -- slow_query | db_error | api_error | outbound_error
  duration_ms INTEGER,             -- query / request duration when known
  source      TEXT,                -- 'db' | 'METHOD /path' | provider host
  detail      TEXT,                -- truncated SQL text / URL
  message     TEXT,                -- scrubbed error message (null for a pure slow query)
  code        TEXT,                -- SQLSTATE / HTTP status / provider status
  meta        JSONB
);

CREATE INDEX IF NOT EXISTS diagnostics_log_at_idx ON diagnostics_log (at);
CREATE INDEX IF NOT EXISTS diagnostics_log_kind_at_idx ON diagnostics_log (kind, at);
