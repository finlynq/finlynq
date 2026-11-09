-- Budget rules (2026-11-09, owner request). Plan: plan/budget-rules.md.
--
-- 1. budget_rules: an amount for a category (or an expense group budgeted as
--    one line) from a start month to an optional end month, with an optional
--    increase (percent or amount, every month or every year in a chosen
--    month). Rules fill the CURRENT and later months; a month that has ended
--    keeps the value it had and is never recomputed.
-- 2. budgets / budget_group_amounts gain:
--    - rules_amount: the part of `amount` that came from rules at the last
--      recompute (NULL = none). `amount` stays the month's WHOLE budget, so
--      every existing reader keeps reading the right number; the typed part
--      is `amount - rules_amount`.
--    - override: "use only this amount" for the month (rules ignored).
--    Existing rows need no backfill: rules_amount NULL means the whole amount
--    was typed, which is what every existing row is.
--
-- The runner wraps the file in a transaction with the schema_migrations
-- bookkeeping insert, so there is no BEGIN/COMMIT here. Idempotent.

ALTER TABLE budgets ADD COLUMN IF NOT EXISTS rules_amount double precision;
ALTER TABLE budgets ADD COLUMN IF NOT EXISTS override boolean NOT NULL DEFAULT false;
ALTER TABLE budget_group_amounts ADD COLUMN IF NOT EXISTS rules_amount double precision;
ALTER TABLE budget_group_amounts ADD COLUMN IF NOT EXISTS override boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS budget_rules (
  id serial PRIMARY KEY,
  user_id text NOT NULL,
  category_id integer REFERENCES categories(id) ON DELETE CASCADE,
  group_name text,
  amount double precision NOT NULL,
  currency text NOT NULL DEFAULT 'USD',
  start_month text NOT NULL,
  end_month text,
  increase_mode text,
  increase_value double precision,
  increase_every text,
  step_month integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT budget_rules_target_check CHECK ((category_id IS NULL) <> (group_name IS NULL)),
  CONSTRAINT budget_rules_increase_mode_check CHECK (increase_mode IN ('percent','amount')),
  CONSTRAINT budget_rules_increase_every_check CHECK (increase_every IN ('month','year')),
  CONSTRAINT budget_rules_step_month_check CHECK (step_month >= 1 AND step_month <= 12),
  CONSTRAINT budget_rules_months_check CHECK (end_month IS NULL OR end_month >= start_month),
  CONSTRAINT budget_rules_amount_check CHECK (amount >= 0)
);
CREATE INDEX IF NOT EXISTS idx_budget_rules_user_id ON budget_rules (user_id);
CREATE INDEX IF NOT EXISTS idx_budget_rules_category_id ON budget_rules (category_id);
