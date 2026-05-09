-- Issue #212 — receipt-OCR rows landed positive on E-type categories.
--
-- Seven rows on Cash CAD (type='A' asset account) carry a positive `amount`
-- with a 'Groceries' (type='E') category, which violates the sign-vs-category
-- invariant the new validator now enforces at every tx-write callsite. This
-- script flips the sign on those seven historical rows so every downstream
-- aggregator (income statement, spending trends, account balance, financial
-- health score, weekly recap, anomalies) reports correct net-negative
-- expenses again.
--
-- Operator playbook (manual, NOT auto-applied via deploy.sh):
--   1. Replace `<userId>` with the affected user's id.
--   2. Run the audit SELECT first; eyeball the seven ids match the expected
--      pattern: account.type='A', category.type='E', amount > 0.
--   3. Run the BEGIN / UPDATE / COMMIT block.
--   4. Re-run the audit SELECT; expect zero rows (the `amount > 0` guard
--      makes the UPDATE idempotent — re-running is a no-op).
--   5. Confirm via the app: Groceries should now report net-negative across
--      the audit window.
--
-- Audit-trio compliance: bumps `updated_at`, preserves `source`. The cash
-- account balance auto-recomputes via `SUM(transactions.amount)` — no manual
-- ledger touch.

-- AUDIT — eyeball before running the UPDATE.
SELECT t.id, t.date, t.amount, t.entered_amount, t.entered_currency,
       a.id   AS account_id,  a.type AS account_type,
       c.type AS category_type, t.source, t.updated_at
  FROM transactions t
  JOIN accounts   a ON a.id = t.account_id
  JOIN categories c ON c.id = t.category_id
 WHERE t.id IN (35626, 35627, 35632, 35633, 35629, 35628, 35630)
   AND t.user_id = '<userId>';

BEGIN;

UPDATE transactions
   SET amount = -amount,
       entered_amount = CASE
         WHEN entered_amount IS NULL THEN NULL
         WHEN entered_amount > 0 THEN -entered_amount
         ELSE entered_amount       -- already negative; idempotent re-run
       END,
       updated_at = NOW()
 WHERE id IN (35626, 35627, 35632, 35633, 35629, 35628, 35630)
   AND user_id = '<userId>'
   AND amount > 0;                 -- idempotency guard

COMMIT;

-- Optional: discover OTHER historical wrong-sign rows beyond the seven the
-- auditor identified. Operator decides whether to bulk-flip a wider set or
-- leave them as historical record.
--
-- SELECT t.id, t.date, t.amount, c.type AS category_type, a.type AS account_type, t.source
--   FROM transactions t
--   JOIN accounts   a ON a.id = t.account_id
--   JOIN categories c ON c.id = t.category_id
--  WHERE t.user_id = '<userId>'
--    AND c.type = 'E'
--    AND a.type = 'A'
--    AND t.amount > 0
--  ORDER BY t.date DESC;
