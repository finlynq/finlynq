-- 2026-11-23: load the balances of statements that were closed without them.
--
-- When a statement's rows were all already in the bank ledger, closing it
-- (finishStatement, from the sweep that runs after any approve or sync) filed
-- it under Processed but dropped its statement balance. Every bank-feed sync
-- carries one, so an account synced daily only got a balance on the days a
-- file was approved by hand, and the bank ledger's "Loaded" column and the
-- balance check had little to go on. finishStatement now loads it; this
-- recovers the ones already dropped.
--
-- Source rows: statements closed that way (status 'approved' with a
-- zero-row, zero-anchor upload batch) that still carry a statement balance.
-- Only dates with NO balance yet are filled (ON CONFLICT DO NOTHING), and when
-- several closed statements share a date the newest one wins (DISTINCT ON,
-- latest received_at first). A statement's per-day parsed anchors (CSV
-- balance column, OFX) are not recovered here; bank-feed syncs carry only the
-- statement balance. Re-runnable: a second run inserts nothing.

INSERT INTO bank_daily_balances
  (user_id, account_id, date, balance, currency, source, source_filenames, upload_batch_id)
SELECT DISTINCT ON (si.user_id, si.bound_account_id, si.statement_balance_date)
  si.user_id,
  si.bound_account_id,
  si.statement_balance_date,
  si.statement_balance,
  COALESCE(si.statement_currency, a.currency, 'CAD'),
  'upload_form',
  CASE WHEN si.original_filename IS NULL THEN ARRAY[]::text[]
       ELSE ARRAY[si.original_filename] END,
  b.id
FROM staged_imports si
JOIN bank_upload_batches b
  ON b.staged_import_id = si.id AND b.user_id = si.user_id
JOIN accounts a
  ON a.id = si.bound_account_id AND a.user_id = si.user_id
WHERE si.status = 'approved'
  AND b.row_count = 0
  AND b.anchor_count = 0
  AND si.statement_balance IS NOT NULL
  AND si.statement_balance_date ~ '^\d{4}-\d{2}-\d{2}$'
ORDER BY si.user_id, si.bound_account_id, si.statement_balance_date, si.received_at DESC
ON CONFLICT (user_id, account_id, date) DO NOTHING;

-- Count each recovered balance on the batch that brought it.
UPDATE bank_upload_batches b
SET anchor_count = sub.n
FROM (
  SELECT upload_batch_id, COUNT(*)::int AS n
  FROM bank_daily_balances
  WHERE upload_batch_id IS NOT NULL
  GROUP BY upload_batch_id
) sub
WHERE sub.upload_batch_id = b.id
  AND b.row_count = 0
  AND b.anchor_count = 0;
