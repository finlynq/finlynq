-- Stream D (2026-04-24) — encrypt display names
--
-- Phase 1: add parallel (name_ct, name_lookup) columns on 6 tables while
-- keeping the plaintext columns + old indexes intact. Writes will populate
-- BOTH old and new columns when a DEK is available. Reads prefer the
-- decrypted ciphertext and fall back to plaintext.
--
-- Phase 2 (lazy backfill on login) and Phase 3 (drop plaintext + swap unique
-- index) are NOT in this migration. They run later, per the plan.
--
-- All statements are idempotent — safe to re-run on any env.

-- accounts: name + alias
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS name_ct text;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS name_lookup text;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS alias_ct text;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS alias_lookup text;

-- categories: name
ALTER TABLE categories ADD COLUMN IF NOT EXISTS name_ct text;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS name_lookup text;

-- goals: name
ALTER TABLE goals ADD COLUMN IF NOT EXISTS name_ct text;
ALTER TABLE goals ADD COLUMN IF NOT EXISTS name_lookup text;

-- loans: name
ALTER TABLE loans ADD COLUMN IF NOT EXISTS name_ct text;
ALTER TABLE loans ADD COLUMN IF NOT EXISTS name_lookup text;

-- subscriptions: name
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS name_ct text;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS name_lookup text;

-- portfolio_holdings: name + symbol
ALTER TABLE portfolio_holdings ADD COLUMN IF NOT EXISTS name_ct text;
ALTER TABLE portfolio_holdings ADD COLUMN IF NOT EXISTS name_lookup text;
ALTER TABLE portfolio_holdings ADD COLUMN IF NOT EXISTS symbol_ct text;
ALTER TABLE portfolio_holdings ADD COLUMN IF NOT EXISTS symbol_lookup text;

-- Partial unique indexes on (user_id, *_lookup). Partial so only rows with a
-- lookup hash participate — rows still on legacy plaintext don't collide.
CREATE UNIQUE INDEX IF NOT EXISTS accounts_user_name_lookup_uniq
  ON accounts (user_id, name_lookup)
  WHERE name_lookup IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS categories_user_name_lookup_uniq
  ON categories (user_id, name_lookup)
  WHERE name_lookup IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS goals_user_name_lookup_uniq
  ON goals (user_id, name_lookup)
  WHERE name_lookup IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS loans_user_name_lookup_uniq
  ON loans (user_id, name_lookup)
  WHERE name_lookup IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_user_name_lookup_uniq
  ON subscriptions (user_id, name_lookup)
  WHERE name_lookup IS NOT NULL;

-- Non-unique: same symbol across accounts for a user is legitimate.
CREATE INDEX IF NOT EXISTS portfolio_holdings_user_name_lookup_idx
  ON portfolio_holdings (user_id, name_lookup)
  WHERE name_lookup IS NOT NULL;

CREATE INDEX IF NOT EXISTS portfolio_holdings_user_symbol_lookup_idx
  ON portfolio_holdings (user_id, symbol_lookup)
  WHERE symbol_lookup IS NOT NULL;
