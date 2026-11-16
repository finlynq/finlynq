-- Split rows count in reports (2026-11-16, owner report).
--
-- A transaction's split rows (transaction_splits) were never read by any
-- report: income statement, trends, YoY, categories, budgets, dashboard,
-- calendar, chat, MCP all summed transactions.amount by
-- transactions.category_id. A payroll deposit with no parent category and a
-- "Wages & salary" split therefore counted nowhere.
--
-- transaction_category_flows is the ONE place that rule lives: one row per
-- unsplit transaction (unchanged), and for a split transaction one row per
-- non-zero split row (its own category, parent's account/date/currency/link
-- ids) plus, when the split rows do not add up to the transaction, one
-- remainder row (amount - sum of splits) under the parent's own category. So
-- the rows of a transaction always add up to the transaction: account totals
-- and report totals keep agreeing, even for an unbalanced legacy split.
--
-- reporting_amount is the parent's reporting amount shared out in proportion
-- to amount (the parent's reporting_rate when the parent amount is 0); an
-- unsplit row keeps its stored value exactly. A split row's own account_id is
-- ignored: the money moved in the parent's account.
--
-- KEEP IN LOCKSTEP with transactionCategoryFlows in src/db/schema-pg.ts
-- (tests/transaction-category-flows-view.test.ts compares the two bodies).
--
-- The runner wraps the file in a transaction. Idempotent.

CREATE INDEX IF NOT EXISTS transaction_splits_transaction_idx
  ON transaction_splits (transaction_id);

DROP VIEW IF EXISTS transaction_category_flows;

CREATE VIEW transaction_category_flows AS
SELECT t.id, NULL::integer AS split_id, t.user_id, t.date, t.account_id, t.category_id, t.currency,
  CASE WHEN s.split_total IS NULL THEN t.amount ELSE t.amount - s.split_total END AS amount,
  t.reporting_currency,
  CASE
    WHEN s.split_total IS NULL OR t.reporting_amount IS NULL THEN t.reporting_amount
    WHEN t.amount <> 0 THEN t.reporting_amount * (t.amount - s.split_total) / t.amount
    WHEN t.reporting_rate IS NOT NULL THEN t.reporting_amount - s.split_total * t.reporting_rate
    ELSE NULL
  END AS reporting_amount,
  t.is_business, t.kind, t.link_id, t.trade_link_id, t.swap_link_id, t.portfolio_holding_id,
  t.payee, t.note, t.tags, t.source, t.quantity
FROM transactions t
LEFT JOIN (
  SELECT transaction_id, SUM(amount) AS split_total FROM transaction_splits GROUP BY transaction_id
) s ON s.transaction_id = t.id
WHERE s.split_total IS NULL OR abs(t.amount - s.split_total) >= 0.005
UNION ALL
SELECT t.id, sp.id AS split_id, t.user_id, t.date, t.account_id, sp.category_id, t.currency,
  sp.amount,
  t.reporting_currency,
  CASE
    WHEN t.reporting_amount IS NULL THEN NULL
    WHEN t.amount <> 0 THEN t.reporting_amount * sp.amount / t.amount
    WHEN t.reporting_rate IS NOT NULL THEN sp.amount * t.reporting_rate
    ELSE NULL
  END AS reporting_amount,
  t.is_business, t.kind, t.link_id, t.trade_link_id, t.swap_link_id, t.portfolio_holding_id,
  t.payee, t.note, t.tags, t.source, t.quantity
FROM transaction_splits sp
JOIN transactions t ON t.id = sp.transaction_id
WHERE sp.amount <> 0;
