-- GH #427 (2026-11-21): saved reports and saved Transactions views.
--
-- One row per saved view. kind says which page it belongs to. The name and
-- the view's settings (config_ct, JSON) are both ENCRYPTED with the user's
-- key: the settings hold account ids, tag names and search text.
-- name_lookup is the HMAC of the name, so names are unique per user and kind.
-- is_default marks the Transactions view that opens when the page loads with
-- no URL filters: at most one per user, and only for Transactions views.
--
-- Declared in src/db/schema-pg.ts too (schema-index/check parity tests).
-- The runner wraps the file in a transaction with the schema_migrations
-- bookkeeping insert, so there is no BEGIN/COMMIT here. Idempotent.

CREATE TABLE IF NOT EXISTS saved_views (
  id serial PRIMARY KEY,
  user_id text NOT NULL,
  kind text NOT NULL,
  name_ct text NOT NULL,
  name_lookup text NOT NULL,
  config_ct text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saved_views_kind_check CHECK (kind IN ('report', 'transactions')),
  CONSTRAINT saved_views_default_kind_check CHECK ((NOT is_default) OR kind = 'transactions')
);

CREATE INDEX IF NOT EXISTS idx_saved_views_user_id ON saved_views (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS saved_views_user_kind_name_unique
  ON saved_views (user_id, kind, name_lookup);
CREATE UNIQUE INDEX IF NOT EXISTS saved_views_user_default_unique
  ON saved_views (user_id, kind) WHERE is_default;
