-- Stream D Phase 4 cutover (2026-05-03) — drop plaintext display-name columns.
--
-- Final cutover for the Stream D encrypted-display-names work that started
-- on 2026-04-24. Before Phase 4 the schema kept both plaintext (`name`,
-- `alias`, `symbol`) and ciphertext columns (`name_ct`, `name_lookup`,
-- `alias_ct`, `alias_lookup`, `symbol_ct`, `symbol_lookup`) for transitional
-- dual-write. After this migration:
--   - The 8 plaintext columns are physically dropped.
--   - The partial unique indexes on (user_id, name_lookup) become full
--     unique indexes (no rows have NULL lookup post-cutover).
--   - Reads route through `name_ct` + DEK; writes through buildNameFields().
--
-- DEPLOY ORDERING:
--   1. Code first (the new release reads ct only and refuses plaintext writes).
--   2. THEN this SQL (drops the now-unread columns).
--
-- Doing the SQL first would leave the running prior-release code reading
-- `name` columns that no longer exist → 500 cascade. The new release is
-- backwards-compatible with the columns still being there (it just doesn't
-- write to them); old release is NOT compatible with the columns missing.
--
-- DO NOT RUN until the matching code release has been live for at least one
-- complete deploy + rollback window. This migration is DESTRUCTIVE.
--
-- Idempotent: safe to re-run (uses DROP COLUMN IF EXISTS, DROP INDEX IF
-- EXISTS, CREATE UNIQUE INDEX preceded by drop).
--
-- Per-env ordering — see docs/migrations.md for the dev / staging / prod
-- playbook.

BEGIN;

-- 1. Verify the DB is ready. Abort if any row still has NULL *_ct on the
-- columns we're about to drop. Post-Phase-A (2026-05-03) every plaintext-
-- only row should have been backfilled or had its plaintext NULL'd after
-- backfill completed. A NULL name_ct here means a stdio-MCP-write-style
-- row that bypassed encryption — those existed pre-Phase-4 because stdio
-- writes had no DEK. Phase 4's gating helper (streamDRefuse) prevents new
-- ones, but pre-existing rows must be audited or NULL'd before this DROP.
DO $$
DECLARE
  n int;
BEGIN
  SELECT COUNT(*) INTO n FROM accounts WHERE name_ct IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'accounts: % rows still have NULL name_ct — migrate or NULL the plaintext side first', n;
  END IF;

  SELECT COUNT(*) INTO n FROM categories WHERE name_ct IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'categories: % rows still have NULL name_ct', n;
  END IF;

  SELECT COUNT(*) INTO n FROM goals WHERE name_ct IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'goals: % rows still have NULL name_ct', n;
  END IF;

  SELECT COUNT(*) INTO n FROM loans WHERE name_ct IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'loans: % rows still have NULL name_ct', n;
  END IF;

  SELECT COUNT(*) INTO n FROM subscriptions WHERE name_ct IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'subscriptions: % rows still have NULL name_ct', n;
  END IF;

  SELECT COUNT(*) INTO n FROM portfolio_holdings WHERE name_ct IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'portfolio_holdings: % rows still have NULL name_ct', n;
  END IF;
END $$;

-- 2. Drop plaintext unique constraints / indexes if any remain. The
-- constraint names differ by how the table was created in different envs
-- (Drizzle-generated vs hand-named); try both.
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

-- 3. Drop the 8 plaintext columns. IF EXISTS makes this idempotent.
ALTER TABLE accounts DROP COLUMN IF EXISTS name;
ALTER TABLE accounts DROP COLUMN IF EXISTS alias;
ALTER TABLE categories DROP COLUMN IF EXISTS name;
ALTER TABLE goals DROP COLUMN IF EXISTS name;
ALTER TABLE loans DROP COLUMN IF EXISTS name;
ALTER TABLE subscriptions DROP COLUMN IF EXISTS name;
ALTER TABLE portfolio_holdings DROP COLUMN IF EXISTS name;
ALTER TABLE portfolio_holdings DROP COLUMN IF EXISTS symbol;

-- 4. Promote the partial unique indexes on (user_id, name_lookup) to full
-- unique indexes. Pre-cutover the partial predicate `name_lookup IS NOT
-- NULL` was needed because legacy/unmigrated rows had NULL lookup. Post-
-- cutover every row is guaranteed to have a non-null lookup (the writers
-- error if DEK is missing), so the partial predicate is no longer needed.
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

-- portfolio_holdings stays non-unique (same symbol across accounts is OK)
-- — keep the index for fast dedup lookups. Same for symbol.
DROP INDEX IF EXISTS portfolio_holdings_user_name_lookup_idx;
CREATE INDEX portfolio_holdings_user_name_lookup_idx
  ON portfolio_holdings (user_id, name_lookup);
DROP INDEX IF EXISTS portfolio_holdings_user_symbol_lookup_idx;
CREATE INDEX portfolio_holdings_user_symbol_lookup_idx
  ON portfolio_holdings (user_id, symbol_lookup);

COMMIT;

-- Post-cutover verification (run separately, not part of the BEGIN/COMMIT):
--   psql ... -c "\d+ accounts"          -- confirm `name` and `alias` are gone
--   psql ... -c "\d+ categories"        -- confirm `name` is gone
--   psql ... -c "\d+ goals"             -- confirm `name` is gone
--   psql ... -c "\d+ loans"             -- confirm `name` is gone
--   psql ... -c "\d+ subscriptions"     -- confirm `name` is gone
--   psql ... -c "\d+ portfolio_holdings" -- confirm `name` and `symbol` are gone
--
-- Reseed demo (dev only):
--   sudo -u deploy /home/projects/pf-dev/scripts/seed-demo.ts
