-- migrate-goals-loans-currency.sql — Phase 4 of the currency rework (2026-04-27).
--
-- Adds `currency` to goals and loans (defaulting to 'CAD' to match other tables).
-- Both stored amounts today (target_amount on goals; principal/payment on loans)
-- with no currency context — silently broken for any non-CAD user.
--
-- Idempotent.

BEGIN;

ALTER TABLE goals
  ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'CAD';

ALTER TABLE loans
  ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'CAD';

-- Where the goal or loan has a linked account, infer currency from it.
UPDATE goals g
   SET currency = a.currency
  FROM accounts a
 WHERE g.account_id = a.id
   AND a.currency IS NOT NULL
   AND a.currency <> ''
   AND g.currency = 'CAD'  -- only fix the default; don't overwrite explicit values
   AND a.currency <> 'CAD';

UPDATE loans l
   SET currency = a.currency
  FROM accounts a
 WHERE l.account_id = a.id
   AND a.currency IS NOT NULL
   AND a.currency <> ''
   AND l.currency = 'CAD'
   AND a.currency <> 'CAD';

COMMIT;
