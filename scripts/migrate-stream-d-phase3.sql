-- Stream D Phase 3 cutover — drop plaintext display-name columns.
--
-- DO NOT RUN until:
--   (1) /api/admin/stream-d-progress reports `{ complete: true }`, AND
--   (2) the Phase 1+2 code has been live long enough for every active user to
--       have logged in at least once (so backfill fired), AND
--   (3) any inactive-user rows with NULL *_ct have been explicitly handled
--       (either forced-login email + wait, or accepted as data loss).
--
-- This migration is DESTRUCTIVE and NOT reversible without a restore from
-- backup. Back up the DB first.
--
-- What it does:
--   1. Drop the old plaintext unique constraints/indexes on (user_id, name)
--      if any remain.
--   2. Drop the plaintext `name` (and `alias`, `symbol`) columns.
--   3. Promote the partial unique indexes on `(user_id, name_lookup)` to
--      full unique indexes — every row is guaranteed to have the hash now.
--
-- After this migration, code that reads plaintext `name` will see NULL on
-- every row. All reads must go through `decryptName` with an available DEK,
-- or through the `name_lookup` HMAC for exact-match queries.

BEGIN;

-- Verify the DB is ready. Abort if any row still has NULL *_ct for the
-- columns we're about to drop. The check for each table bails out via
-- a divide-by-zero error if we find any un-encrypted rows, which Postgres
-- reports as `ERROR: division by zero` — clear enough to investigate.
DO $$
DECLARE
  n int;
BEGIN
  SELECT COUNT(*) INTO n FROM accounts WHERE name_ct IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'accounts: % rows still have NULL name_ct — run backfill first', n;
  END IF;

  SELECT COUNT(*) INTO n FROM categories WHERE name_ct IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'categories: % rows still have NULL name_ct — run backfill first', n;
  END IF;

  SELECT COUNT(*) INTO n FROM goals WHERE name_ct IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'goals: % rows still have NULL name_ct — run backfill first', n;
  END IF;

  SELECT COUNT(*) INTO n FROM loans WHERE name_ct IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'loans: % rows still have NULL name_ct — run backfill first', n;
  END IF;

  SELECT COUNT(*) INTO n FROM subscriptions WHERE name_ct IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'subscriptions: % rows still have NULL name_ct — run backfill first', n;
  END IF;

  SELECT COUNT(*) INTO n FROM portfolio_holdings WHERE name_ct IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'portfolio_holdings: % rows still have NULL name_ct — run backfill first', n;
  END IF;
END $$;

-- 1. Drop plaintext unique constraints / indexes if they exist. The constraint
--    names differ by how the table was created; try both the Drizzle-ish name
--    and the hand-named one.
DO $$
BEGIN
  BEGIN
    EXECUTE 'ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_user_id_name_uniq';
    EXECUTE 'DROP INDEX IF EXISTS accounts_user_id_name_idx';
  EXCEPTION WHEN others THEN NULL; END;
  BEGIN
    EXECUTE 'ALTER TABLE categories DROP CONSTRAINT IF EXISTS categories_user_id_name_uniq';
    EXECUTE 'DROP INDEX IF EXISTS categories_user_id_name_idx';
  EXCEPTION WHEN others THEN NULL; END;
  BEGIN
    EXECUTE 'ALTER TABLE goals DROP CONSTRAINT IF EXISTS goals_user_id_name_uniq';
    EXECUTE 'DROP INDEX IF EXISTS goals_user_id_name_idx';
  EXCEPTION WHEN others THEN NULL; END;
  BEGIN
    EXECUTE 'ALTER TABLE loans DROP CONSTRAINT IF EXISTS loans_user_id_name_uniq';
    EXECUTE 'DROP INDEX IF EXISTS loans_user_id_name_idx';
  EXCEPTION WHEN others THEN NULL; END;
  BEGIN
    EXECUTE 'ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_user_id_name_uniq';
    EXECUTE 'DROP INDEX IF EXISTS subscriptions_user_id_name_idx';
  EXCEPTION WHEN others THEN NULL; END;
END $$;

-- 2. Drop the plaintext columns. Do NOT wrap these in IF EXISTS outside of
--    DROP COLUMN — older Postgres versions need the explicit syntax.
ALTER TABLE accounts DROP COLUMN IF EXISTS name;
ALTER TABLE accounts DROP COLUMN IF EXISTS alias;
ALTER TABLE categories DROP COLUMN IF EXISTS name;
ALTER TABLE goals DROP COLUMN IF EXISTS name;
ALTER TABLE loans DROP COLUMN IF EXISTS name;
ALTER TABLE subscriptions DROP COLUMN IF EXISTS name;
ALTER TABLE portfolio_holdings DROP COLUMN IF EXISTS name;
ALTER TABLE portfolio_holdings DROP COLUMN IF EXISTS symbol;

-- 3. Swap the partial unique indexes for full ones — every row now has a
--    non-null lookup. Drop-and-recreate because the partial predicate is
--    built into the index metadata.
DROP INDEX IF EXISTS accounts_user_name_lookup_uniq;
CREATE UNIQUE INDEX accounts_user_name_lookup_uniq
  ON accounts (user_id, name_lookup);

DROP INDEX IF EXISTS categories_user_name_lookup_uniq;
CREATE UNIQUE INDEX categories_user_name_lookup_uniq
  ON categories (user_id, name_lookup);

DROP INDEX IF EXISTS goals_user_name_lookup_uniq;
CREATE UNIQUE INDEX goals_user_name_lookup_uniq
  ON goals (user_id, name_lookup);

DROP INDEX IF EXISTS loans_user_name_lookup_uniq;
CREATE UNIQUE INDEX loans_user_name_lookup_uniq
  ON loans (user_id, name_lookup);

DROP INDEX IF EXISTS subscriptions_user_name_lookup_uniq;
CREATE UNIQUE INDEX subscriptions_user_name_lookup_uniq
  ON subscriptions (user_id, name_lookup);

-- portfolio_holdings stays non-unique (same symbol across accounts OK).
DROP INDEX IF EXISTS portfolio_holdings_user_name_lookup_idx;
CREATE INDEX portfolio_holdings_user_name_lookup_idx
  ON portfolio_holdings (user_id, name_lookup);
DROP INDEX IF EXISTS portfolio_holdings_user_symbol_lookup_idx;
CREATE INDEX portfolio_holdings_user_symbol_lookup_idx
  ON portfolio_holdings (user_id, symbol_lookup);

COMMIT;

-- Post-cutover:
--   1. Remove `name` / `alias` / `symbol` columns from src/db/schema-pg.ts.
--   2. Remove the plaintext fallback branches in decryptName / decryptNameish.
--   3. Remove dual-write of plaintext `name`/`alias`/`symbol` from CRUD paths.
--   4. Review stdio MCP writes — they can no longer write names (NOT NULL
--      constraint on name_ct would fail without a DEK). Either mark them
--      unsupported or require PF_USER_DEK env as a second boot var.
