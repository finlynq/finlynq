-- Budget v2: a cash-flow budget (2026-10-30, in-app feedback #26 + owner
-- request). Plan: plan/budget-v2.md.
--
-- 1. accounts.budget_role / budget_payment_amount: how an account counts in
--    the budget. NULL = automatic (a liability linked to a non-revolving loan
--    is a debt payment, everything else counts by category).
-- 2. budget_line_settings: per category or per category GROUP: left out of
--    the budget, budgeted as one group line, leftover rolls over, and whether
--    overspending carries.
-- 3. budget_group_amounts: the monthly amount of a group budgeted as one.
-- 4. budget_carryover_sets: a user's own reset (0) or edit of what a rollover
--    line carries into a month; the walk restarts from the latest one.
-- 5. budgets.currency defaults to USD, and budgets stamped CAD only because
--    a writer omitted the currency are relabelled to the user's display
--    currency (amount unchanged). No budget screen ever offered a currency, so
--    the amount was always typed in the display currency the user was looking
--    at; MCP manage_budgets never wrote one at all. Only rows labelled CAD
--    for a user who reports in another currency AND has no CAD account are
--    touched: for anyone else CAD could have been meant.
--
-- The runner wraps the file in a transaction with the schema_migrations
-- bookkeeping insert, so there is no BEGIN/COMMIT here. Idempotent.

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS budget_role text;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS budget_payment_amount double precision;
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_budget_role_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_budget_role_check
  CHECK (budget_role IN ('categories','debt_payment','excluded'));

CREATE TABLE IF NOT EXISTS budget_line_settings (
  id serial PRIMARY KEY,
  user_id text NOT NULL,
  category_id integer REFERENCES categories(id) ON DELETE CASCADE,
  group_name text,
  excluded boolean NOT NULL DEFAULT false,
  by_group boolean NOT NULL DEFAULT false,
  rollover boolean NOT NULL DEFAULT false,
  rollover_negative text NOT NULL DEFAULT 'carry',
  CONSTRAINT budget_line_settings_target_check CHECK ((category_id IS NULL) <> (group_name IS NULL)),
  CONSTRAINT budget_line_settings_rollover_negative_check CHECK (rollover_negative IN ('carry','reset'))
);
CREATE INDEX IF NOT EXISTS idx_budget_line_settings_user_id ON budget_line_settings (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS budget_line_settings_category_unique
  ON budget_line_settings (user_id, category_id) WHERE category_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS budget_line_settings_group_unique
  ON budget_line_settings (user_id, group_name) WHERE group_name IS NOT NULL;

CREATE TABLE IF NOT EXISTS budget_group_amounts (
  id serial PRIMARY KEY,
  user_id text NOT NULL,
  group_name text NOT NULL,
  month text NOT NULL,
  amount double precision NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'USD'
);
CREATE UNIQUE INDEX IF NOT EXISTS budget_group_amounts_user_group_month_unique
  ON budget_group_amounts (user_id, group_name, month);

CREATE TABLE IF NOT EXISTS budget_carryover_sets (
  id serial PRIMARY KEY,
  user_id text NOT NULL,
  category_id integer REFERENCES categories(id) ON DELETE CASCADE,
  group_name text,
  month text NOT NULL,
  amount double precision NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'USD',
  CONSTRAINT budget_carryover_sets_target_check CHECK ((category_id IS NULL) <> (group_name IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_budget_carryover_sets_user_id ON budget_carryover_sets (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS budget_carryover_sets_category_unique
  ON budget_carryover_sets (user_id, category_id, month) WHERE category_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS budget_carryover_sets_group_unique
  ON budget_carryover_sets (user_id, group_name, month) WHERE group_name IS NOT NULL;

ALTER TABLE budgets ALTER COLUMN currency SET DEFAULT 'USD';

UPDATE budgets b
   SET currency = d.display
  FROM (
    SELECT b2.user_id,
           COALESCE((SELECT UPPER(TRIM(s.value)) FROM settings s
                      WHERE s.user_id = b2.user_id AND s.key = 'display_currency'
                      LIMIT 1), 'USD') AS display
      FROM budgets b2
     GROUP BY b2.user_id
  ) d
 WHERE d.user_id = b.user_id
   AND UPPER(b.currency) = 'CAD'
   AND d.display <> 'CAD'
   AND NOT EXISTS (
     SELECT 1 FROM accounts a WHERE a.user_id = b.user_id AND UPPER(a.currency) = 'CAD'
   );
