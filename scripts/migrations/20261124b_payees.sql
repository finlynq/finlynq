-- 2026-11-24: a list of the payees a user has typed (or an assistant has
-- recorded), behind the Payee field's suggestions.
--
-- One row per user and payee. The name is ENCRYPTED with the user's key like
-- every other payee (name_ct) and matched through name_lookup: the same keyed
-- hash of the normalized name (lowercase, whitespace collapsed) that the
-- other name_lookup columns use, so "Corner  Cafe" and "corner cafe" are one
-- payee. use_count and last_used_at rank the suggestions; last_category_id is
-- the category most recently used with the payee, offered when it is picked.
--
-- This is an index for suggestions only: transactions keep their own payee
-- text and nothing reads this table to total or report anything. Imported
-- bank rows are NOT added (their raw descriptors would fill the list with
-- near-duplicates); existing typed and assistant-recorded payees are filled
-- in by the app the first time a user's list is read, since that needs the
-- user's key.
--
-- Declared in src/db/schema-pg.ts too (schema-index parity test).
-- The runner wraps the file in a transaction with the schema_migrations
-- bookkeeping insert, so there is no BEGIN/COMMIT here. Idempotent.

CREATE TABLE IF NOT EXISTS payees (
  id serial PRIMARY KEY,
  user_id text NOT NULL,
  name_ct text NOT NULL,
  name_lookup text NOT NULL,
  use_count integer NOT NULL DEFAULT 1,
  last_category_id integer REFERENCES categories(id) ON DELETE SET NULL,
  last_used_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS payees_user_lookup_uq
  ON payees (user_id, name_lookup);
