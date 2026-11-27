-- GH #462 (2026-11-27): a goal-to-account link can count PART of the account
-- instead of the whole of it, so two goals sharing one savings account no
-- longer both count its full balance (or full growth).
--
--   allocation_kind NULL       the whole account (every link before this; no backfill)
--   allocation_kind 'amount'   up to allocation_value, in the GOAL's currency
--                              (never more than the account actually holds)
--   allocation_kind 'percent'  allocation_value percent of the account (0 < v <= 100)
--
-- Math lives in src/lib/goals/allocation.ts. Additive and idempotent.

ALTER TABLE goal_accounts ADD COLUMN IF NOT EXISTS allocation_kind text;
ALTER TABLE goal_accounts ADD COLUMN IF NOT EXISTS allocation_value double precision;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'goal_accounts_allocation_kind_check') THEN
    ALTER TABLE goal_accounts ADD CONSTRAINT goal_accounts_allocation_kind_check
      CHECK (allocation_kind IN ('amount', 'percent'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'goal_accounts_allocation_value_check') THEN
    ALTER TABLE goal_accounts ADD CONSTRAINT goal_accounts_allocation_value_check
      CHECK (
        (allocation_kind IS NULL AND allocation_value IS NULL)
        OR (allocation_kind = 'amount' AND allocation_value > 0)
        OR (allocation_kind = 'percent' AND allocation_value > 0 AND allocation_value <= 100)
      );
  END IF;
END $$;
