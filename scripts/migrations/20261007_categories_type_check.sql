-- categories.type: normalize word-form types to their codes, then pin the
-- vocabulary with a CHECK.
--
-- Every report filters on the literal codes (E expense / I income / R
-- transfer), but the column was unconstrained text. POST /api/budgets/seed (the
-- onboarding budgets step) created categories with type 'expense', and
-- POST/PUT /api/categories validated type as a bare string, so those
-- categories' transactions silently fell out of every income/expense total.
-- Measured on pf_dev 2026-10-07: 59 'expense' categories across 12 users, 214
-- transactions affected. Reported by a user via in-app feedback 2026-10-05.
--
-- The aliases below must stay in lockstep with CATEGORY_TYPE_ALIASES in
-- src/lib/categories/category-type.ts (tests/category-type.test.ts checks).
--
-- Idempotent: the UPDATEs only touch non-canonical rows, and the constraint is
-- added only when absent.

UPDATE categories SET type = 'E'
  WHERE type <> 'E' AND lower(btrim(type)) IN ('e', 'expense', 'expenses');

UPDATE categories SET type = 'I'
  WHERE type <> 'I' AND lower(btrim(type)) IN ('i', 'income');

UPDATE categories SET type = 'R'
  WHERE type <> 'R' AND lower(btrim(type)) IN ('r', 't', 'transfer', 'transfers', 'reconciliation');

-- A value none of the aliases recognise can't be mapped safely, and a failed
-- ADD CONSTRAINT would fail the deploy. In that case add the constraint NOT
-- VALID: it still rejects every new bad write, leaves the stray rows in place
-- for a human to look at, and logs a warning naming how many there are.
DO $$
DECLARE
  stray integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'categories_type_check'
  ) THEN
    SELECT count(*) INTO stray FROM categories WHERE type NOT IN ('E', 'I', 'R');
    IF stray = 0 THEN
      ALTER TABLE categories
        ADD CONSTRAINT categories_type_check CHECK (type IN ('E', 'I', 'R'));
    ELSE
      ALTER TABLE categories
        ADD CONSTRAINT categories_type_check CHECK (type IN ('E', 'I', 'R')) NOT VALID;
      RAISE WARNING 'categories_type_check added NOT VALID: % row(s) with an unrecognised type remain', stray;
    END IF;
  END IF;
END $$;
