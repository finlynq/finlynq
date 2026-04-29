-- ⚠️  SUPERSEDED by scripts/migrate-stream-d-phase3-per-user.sql + the runtime
-- helper in src/lib/crypto/stream-d-phase3-null.ts. The eager all-or-nothing
-- variant below was applied to PROD only on 2026-04-24. New environments
-- (staging, dev) get the per-user lazy cutover instead — it's safe to run on
-- DBs where some users still have un-backfilled rows or DEK-mismatch issues
-- (the per-user helper checks both before NULLing). Kept here as a record of
-- prod's eager run; do not run this script on new envs.
--
-- Stream D Phase 3 (pragmatic variant) — NULL the plaintext name columns on
-- encrypted rows, keep the plaintext column in the schema. Same privacy
-- benefit vs a DB-dump attacker (no readable plaintext on rows that were
-- backfilled) but no schema drift — Drizzle queries that still reference
-- `accounts.name` keep compiling, and stdio MCP can still INSERT plaintext
-- without hitting a NOT NULL violation.
--
-- DO NOT RUN until:
--   (1) /api/admin/stream-d-progress reports `{ complete: true }`, AND
--   (2) every active user has logged in at least once since Phase 1+2 shipped
--
-- After this migration, code that reads plaintext `name` without decrypting
-- `name_ct` gets NULL on backfilled rows. The dual-read pattern
-- (decryptName(ct, dek, fallback)) returns the decrypted value; code that
-- doesn't use it needs a follow-up to decrypt post-query.
--
-- Reversible? Not fully — plaintext is gone from the encrypted rows. But
-- `name_ct` is still there and decryptable with the user's DEK, so data is
-- recoverable per-user on their next login.

BEGIN;

-- Pre-check: every backfilled row has a ciphertext. If any row has plaintext
-- but no ct, NULLing it would be data loss.
DO $$
DECLARE
  missing int;
BEGIN
  SELECT COUNT(*) INTO missing FROM accounts WHERE name IS NOT NULL AND name_ct IS NULL;
  IF missing > 0 THEN RAISE EXCEPTION 'accounts: % rows have plaintext but no ciphertext — run backfill first', missing; END IF;

  SELECT COUNT(*) INTO missing FROM categories WHERE name IS NOT NULL AND name_ct IS NULL;
  IF missing > 0 THEN RAISE EXCEPTION 'categories: % rows have plaintext but no ciphertext', missing; END IF;

  SELECT COUNT(*) INTO missing FROM goals WHERE name IS NOT NULL AND name_ct IS NULL;
  IF missing > 0 THEN RAISE EXCEPTION 'goals: % rows have plaintext but no ciphertext', missing; END IF;

  SELECT COUNT(*) INTO missing FROM loans WHERE name IS NOT NULL AND name_ct IS NULL;
  IF missing > 0 THEN RAISE EXCEPTION 'loans: % rows have plaintext but no ciphertext', missing; END IF;

  SELECT COUNT(*) INTO missing FROM subscriptions WHERE name IS NOT NULL AND name_ct IS NULL;
  IF missing > 0 THEN RAISE EXCEPTION 'subscriptions: % rows have plaintext but no ciphertext', missing; END IF;

  SELECT COUNT(*) INTO missing FROM portfolio_holdings WHERE name IS NOT NULL AND name_ct IS NULL;
  IF missing > 0 THEN RAISE EXCEPTION 'portfolio_holdings: % rows have plaintext but no ciphertext', missing; END IF;
END $$;

-- Relax NOT NULL on `name` columns so NULLing works. The encrypted row
-- (where name_ct IS NOT NULL) becomes the authoritative source.
ALTER TABLE accounts ALTER COLUMN name DROP NOT NULL;
ALTER TABLE categories ALTER COLUMN name DROP NOT NULL;
ALTER TABLE goals ALTER COLUMN name DROP NOT NULL;
ALTER TABLE loans ALTER COLUMN name DROP NOT NULL;
ALTER TABLE subscriptions ALTER COLUMN name DROP NOT NULL;
-- portfolio_holdings.name is already nullable in some envs; handle idempotently.
DO $$ BEGIN
  ALTER TABLE portfolio_holdings ALTER COLUMN name DROP NOT NULL;
EXCEPTION WHEN others THEN NULL; END $$;

-- NULL plaintext on encrypted rows. accounts gets alias treated the same way.
UPDATE accounts SET name = NULL WHERE name_ct IS NOT NULL;
UPDATE accounts SET alias = NULL WHERE alias_ct IS NOT NULL;
UPDATE categories SET name = NULL WHERE name_ct IS NOT NULL;
UPDATE goals SET name = NULL WHERE name_ct IS NOT NULL;
UPDATE loans SET name = NULL WHERE name_ct IS NOT NULL;
UPDATE subscriptions SET name = NULL WHERE name_ct IS NOT NULL;
UPDATE portfolio_holdings SET name = NULL WHERE name_ct IS NOT NULL;
UPDATE portfolio_holdings SET symbol = NULL WHERE symbol_ct IS NOT NULL;

-- Drop any legacy unique constraints on (user_id, name) since those rows
-- are now all NULL. The unique index on (user_id, name_lookup) still
-- enforces per-user uniqueness. Partial (WHERE name_lookup IS NOT NULL)
-- so legacy stdio-created rows (no lookup) don't collide with encrypted.
DO $$
BEGIN
  BEGIN EXECUTE 'ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_user_id_name_uniq'; EXCEPTION WHEN others THEN NULL; END;
  BEGIN EXECUTE 'DROP INDEX IF EXISTS accounts_user_id_name_idx'; EXCEPTION WHEN others THEN NULL; END;
  BEGIN EXECUTE 'ALTER TABLE categories DROP CONSTRAINT IF EXISTS categories_user_id_name_uniq'; EXCEPTION WHEN others THEN NULL; END;
  BEGIN EXECUTE 'DROP INDEX IF EXISTS categories_user_id_name_idx'; EXCEPTION WHEN others THEN NULL; END;
  BEGIN EXECUTE 'ALTER TABLE goals DROP CONSTRAINT IF EXISTS goals_user_id_name_uniq'; EXCEPTION WHEN others THEN NULL; END;
  BEGIN EXECUTE 'DROP INDEX IF EXISTS goals_user_id_name_idx'; EXCEPTION WHEN others THEN NULL; END;
  BEGIN EXECUTE 'ALTER TABLE loans DROP CONSTRAINT IF EXISTS loans_user_id_name_uniq'; EXCEPTION WHEN others THEN NULL; END;
  BEGIN EXECUTE 'DROP INDEX IF EXISTS loans_user_id_name_idx'; EXCEPTION WHEN others THEN NULL; END;
  BEGIN EXECUTE 'ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_user_id_name_uniq'; EXCEPTION WHEN others THEN NULL; END;
  BEGIN EXECUTE 'DROP INDEX IF EXISTS subscriptions_user_id_name_idx'; EXCEPTION WHEN others THEN NULL; END;
END $$;

COMMIT;

-- Post-migration verification queries:
--   SELECT COUNT(*) FROM accounts WHERE name IS NOT NULL;   -- should be 0
--   SELECT COUNT(*) FROM categories WHERE name IS NOT NULL; -- should be 0
--   SELECT COUNT(*) FROM goals WHERE name IS NOT NULL;      -- should be 0
--   SELECT COUNT(*) FROM loans WHERE name IS NOT NULL;      -- should be 0
--   SELECT COUNT(*) FROM subscriptions WHERE name IS NOT NULL; -- should be 0
--   SELECT COUNT(*) FROM portfolio_holdings WHERE name IS NOT NULL; -- should be 0
