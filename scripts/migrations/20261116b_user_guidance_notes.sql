-- FINLYNQ-219 (2026-11-16): a user's guidance notes, the personal half of the
-- AI guidance library. Short Markdown notes an assistant reads at the start of
-- a session and that both the assistant and the user can change (Settings →
-- AI guidance, MCP get_guidance / manage_guidance_notes).
--
-- Every text column is encrypted with the user's DEK (v1: ciphertext).
-- path_lookup is the HMAC of the path, so one ACTIVE note per path per user;
-- a retired note keeps its row and revisions, and its path can be reused.
-- Declared in src/db/schema-pg.ts too (schema-index/check parity tests).
--
-- The runner wraps the file in a transaction with the schema_migrations
-- bookkeeping insert, so there is no BEGIN/COMMIT here. Idempotent.

CREATE TABLE IF NOT EXISTS user_guidance_notes (
  id serial PRIMARY KEY,
  user_id text NOT NULL,
  path_ct text NOT NULL,
  path_lookup text NOT NULL,
  title_ct text NOT NULL,
  summary_ct text,
  body_ct text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  updated_by text NOT NULL DEFAULT 'user',
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_guidance_notes_updated_by_check CHECK (updated_by IN ('user','assistant'))
);
CREATE INDEX IF NOT EXISTS idx_user_guidance_notes_user_id ON user_guidance_notes (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS user_guidance_notes_active_path_unique
  ON user_guidance_notes (user_id, path_lookup) WHERE (retired_at IS NULL);

CREATE TABLE IF NOT EXISTS user_guidance_note_revisions (
  id serial PRIMARY KEY,
  note_id integer NOT NULL REFERENCES user_guidance_notes(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  version integer NOT NULL,
  action text NOT NULL,
  path_ct text NOT NULL,
  title_ct text NOT NULL,
  summary_ct text,
  body_ct text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_guidance_note_revisions_action_check CHECK (action IN ('save','retire')),
  CONSTRAINT user_guidance_note_revisions_updated_by_check CHECK (updated_by IN ('user','assistant'))
);
CREATE INDEX IF NOT EXISTS idx_user_guidance_note_revisions_note ON user_guidance_note_revisions (note_id, version);
CREATE INDEX IF NOT EXISTS idx_user_guidance_note_revisions_user_id ON user_guidance_note_revisions (user_id);
