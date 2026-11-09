-- loans.payment_overrides — a different payment on single rows of a
-- calculated schedule, with the interest still calculated (2026-11-09, owner
-- request).
--
--   payment_overrides  { "YYYY-MM-DD": amount }
--     The whole payment made on that payment date (any extra payment
--     included). The interest is still worked out from the balance owed, so
--     the principal and every later balance follow: a bigger payment shortens
--     the loan, a smaller one (or 0) adds the unpaid interest to the balance.
--
-- Before this, a different payment meant switching the whole loan to a manual
-- schedule, where every row's interest then had to be typed in by hand.
--
-- Nullable, NULL = no edited payments, so every existing loan is unchanged.
-- Read only through `loanScheduleExtras` (loan-calculator.ts), like
-- manual_schedule and interest_overrides.
--
-- Additive + idempotent.

ALTER TABLE loans ADD COLUMN IF NOT EXISTS payment_overrides JSONB;
