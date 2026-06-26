-- Diagnostics Phase 2 — operation attribution, per-op rollup, durable CPU history.
--
-- (1) diagnostics_log gains `op` (the operation/route that triggered the query —
--     e.g. 'rebuild:investment', 'GET /api/net-worth-history') + `env` (prod/dev)
--     so each row says what called it and which environment it's from.
-- (2) op_rollup — per-(operation, hour) aggregate of count / total wall-clock ms /
--     slow-query count / error count. Powers the "Top operations (24h)" panel
--     ("where is time going / where to focus"). Written by an in-app flush that
--     upserts deltas every ~30s; trimmed to ~7 days by the app.
-- (3) system_metrics_sample — durable CPU/load/mem samples (~1/min) so Server
--     Health can show a real 24h chart instead of a since-restart sparkline.
--     Trimmed to ~7 days by the app.
--
-- All three are global/plaintext (no user_id, no DEK) and NOT in the per-user
-- wipe path. Additive + idempotent. Auto-applied by deploy.sh.

ALTER TABLE diagnostics_log ADD COLUMN IF NOT EXISTS op  TEXT;
ALTER TABLE diagnostics_log ADD COLUMN IF NOT EXISTS env TEXT;

CREATE TABLE IF NOT EXISTS op_rollup (
  op          TEXT NOT NULL,
  bucket      TIMESTAMPTZ NOT NULL,   -- hour-aligned
  count       BIGINT NOT NULL DEFAULT 0,
  total_ms    BIGINT NOT NULL DEFAULT 0,
  slow_count  BIGINT NOT NULL DEFAULT 0,
  error_count BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (op, bucket)
);
CREATE INDEX IF NOT EXISTS op_rollup_bucket_idx ON op_rollup (bucket);

CREATE TABLE IF NOT EXISTS system_metrics_sample (
  id           SERIAL PRIMARY KEY,
  at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  cpu_pct      REAL,
  load1        REAL,
  proc_cpu_pct REAL,
  mem_used_mb  INTEGER,
  mem_total_mb INTEGER
);
CREATE INDEX IF NOT EXISTS system_metrics_sample_at_idx ON system_metrics_sample (at);
