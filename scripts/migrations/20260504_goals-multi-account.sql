-- Goals multi-account linking (issue #130, 2026-05-04).
--
-- Adds the `goal_accounts` join table so a single goal can be tied to N
-- accounts (e.g. an emergency fund spanning Chequing + Savings). Backfills
-- existing single-account links from `goals.account_id` so dual-write code
-- stays consistent during the deprecation window.
--
-- The legacy `goals.account_id` column STAYS for one release cycle as a
-- fallback / backup-restore safety net; a follow-up issue will drop it once
-- every code path round-trips through the join table.
--
-- Idempotent: safe to re-run. The runner in deploy.sh wraps the whole file
-- in a transaction with the schema_migrations bookkeeping insert — do NOT
-- add a BEGIN/COMMIT block here, it would commit the outer txn early.

CREATE TABLE IF NOT EXISTS goal_accounts (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  goal_id INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  UNIQUE (goal_id, account_id, user_id)
);

CREATE INDEX IF NOT EXISTS goal_accounts_user_goal ON goal_accounts (user_id, goal_id);
CREATE INDEX IF NOT EXISTS goal_accounts_user_account ON goal_accounts (user_id, account_id);

-- Backfill existing single-account links. ON CONFLICT is a guard for re-runs.
INSERT INTO goal_accounts (user_id, goal_id, account_id)
SELECT user_id, id, account_id
FROM goals
WHERE account_id IS NOT NULL
ON CONFLICT (goal_id, account_id, user_id) DO NOTHING;
