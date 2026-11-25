-- Forecast Phase 2 (2026-11-25, plan/forecast-scenarios.md sections 8a + 9):
-- saved scenarios, their revision history, and saved snapshots.
--
-- forecast_scenarios: one row per saved scenario. doc_ct is the scenario
--   (a full config, or a variant's differences from its parent) as JSON,
--   ENCRYPTED with the user's key, like the name. parent_id points at the
--   stored parent of a variant (NULL for a full config or a variant of the
--   built-in Baseline); deleting a parent is refused while variants exist
--   (store), so the FK has no cascade. version increases on every save
--   (expectedVersion guards stale writes). updated_by says who saved last.
-- forecast_scenario_revisions: append-only copies of doc_ct per save, for
--   undo and "what did the assistant change"; capped per scenario by the store.
-- forecast_snapshots: a frozen RESULT (numbers) plus the settings that made
--   it, both encrypted; scenario_id is informational (SET NULL on delete).
--
-- Declared in src/db/schema-pg.ts too (schema-index/check parity tests).
-- The runner wraps the file in a transaction; no BEGIN/COMMIT here. Idempotent.

CREATE TABLE IF NOT EXISTS forecast_scenarios (
  id serial PRIMARY KEY,
  user_id text NOT NULL,
  name_ct text NOT NULL,
  name_lookup text NOT NULL,
  parent_id integer REFERENCES forecast_scenarios(id),
  doc_ct text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  updated_by text NOT NULL DEFAULT 'user',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT forecast_scenarios_updated_by_check CHECK (updated_by IN ('user', 'assistant'))
);
CREATE INDEX IF NOT EXISTS idx_forecast_scenarios_user_id ON forecast_scenarios (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS forecast_scenarios_user_name_unique ON forecast_scenarios (user_id, name_lookup);
CREATE INDEX IF NOT EXISTS idx_forecast_scenarios_parent_id ON forecast_scenarios (parent_id);

CREATE TABLE IF NOT EXISTS forecast_scenario_revisions (
  id serial PRIMARY KEY,
  user_id text NOT NULL,
  scenario_id integer NOT NULL REFERENCES forecast_scenarios(id) ON DELETE CASCADE,
  version integer NOT NULL,
  doc_ct text NOT NULL,
  summary_ct text,
  updated_by text NOT NULL DEFAULT 'user',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT forecast_scenario_revisions_updated_by_check CHECK (updated_by IN ('user', 'assistant'))
);
CREATE INDEX IF NOT EXISTS idx_forecast_scenario_revisions_user_id ON forecast_scenario_revisions (user_id);
CREATE INDEX IF NOT EXISTS idx_forecast_scenario_revisions_scenario ON forecast_scenario_revisions (scenario_id, version);

CREATE TABLE IF NOT EXISTS forecast_snapshots (
  id serial PRIMARY KEY,
  user_id text NOT NULL,
  scenario_id integer REFERENCES forecast_scenarios(id) ON DELETE SET NULL,
  name_ct text NOT NULL,
  name_lookup text NOT NULL,
  result_ct text NOT NULL,
  config_ct text NOT NULL,
  result_schema_version integer NOT NULL,
  engine_version integer NOT NULL,
  inputs_as_of timestamptz NOT NULL,
  created_by text NOT NULL DEFAULT 'user',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT forecast_snapshots_created_by_check CHECK (created_by IN ('user', 'assistant'))
);
CREATE INDEX IF NOT EXISTS idx_forecast_snapshots_user_id ON forecast_snapshots (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS forecast_snapshots_user_name_unique ON forecast_snapshots (user_id, name_lookup);
CREATE INDEX IF NOT EXISTS idx_forecast_snapshots_scenario_id ON forecast_snapshots (scenario_id);
