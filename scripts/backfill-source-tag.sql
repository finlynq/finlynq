-- ─────────────────────────────────────────────────────────────────────────────
--  backfill-source-tag.sql — one-off optional backfill for issue #33
-- ─────────────────────────────────────────────────────────────────────────────
--
--  Purpose
--  -------
--  Mark rows that were imported by a known connector (e.g. WealthPosition)
--  with a `source:<connector>` tag. New imports carry this tag automatically;
--  this script retroactively tags rows that pre-date the auto-tag rollout so
--  future statement-reconciliation dedup can identify them.
--
--  Scope (you fill these in)
--  -------------------------
--    :user_id     — the Finlynq user id (uuid string)
--    :source      — connector slug, e.g. 'wealthposition'
--    :account_ids — comma-separated account ids you imported into via that
--                   connector. If you mapped 5 WP accounts onto 1 Finlynq
--                   brokerage, list just that brokerage.
--    :from_date   — earliest tx date to touch (YYYY-MM-DD)
--    :to_date     — latest   tx date to touch (YYYY-MM-DD)
--
--  IMPORTANT — encryption caveat
--  -----------------------------
--  Most managed-cloud / privacy-hardened deployments store transactions.tags
--  as envelope-encrypted ciphertext (`v1:...`). Plain SQL cannot re-encrypt
--  in place without the user's DEK, so this script SKIPS encrypted rows
--  (`tags LIKE 'v1:%'`). For those, re-run the original import through the
--  app with the new connector code, or write a Node-side backfill that
--  unwraps the DEK per-user (out of scope here).
--
--  Tag merge policy
--  ----------------
--   - `tags` IS NULL or empty   → set to `source:<connector>`
--   - already contains `source:` → leave untouched (idempotent)
--   - other tags present        → prepend `source:<connector>,…`
--
--  Run as a transaction so a typo'd parameter rolls back cleanly. Inspect the
--  SELECT preview before committing.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── Preview what would change. Run this first; sanity-check the count + a
--    handful of rows match the connector you actually imported.
SELECT id, date, account_id, payee, tags
  FROM transactions
 WHERE user_id   = :'user_id'
   AND account_id = ANY(string_to_array(:'account_ids', ',')::int[])
   AND date BETWEEN :'from_date' AND :'to_date'
   AND (tags IS NULL OR tags NOT LIKE 'v1:%')
   AND (tags IS NULL OR tags NOT ILIKE '%source:%')
 ORDER BY date, id
 LIMIT 50;

-- ── Apply. Idempotent — re-running won't double-tag.
UPDATE transactions
   SET tags = CASE
                WHEN tags IS NULL OR tags = ''
                  THEN 'source:' || :'source'
                ELSE 'source:' || :'source' || ',' || tags
              END
 WHERE user_id   = :'user_id'
   AND account_id = ANY(string_to_array(:'account_ids', ',')::int[])
   AND date BETWEEN :'from_date' AND :'to_date'
   AND (tags IS NULL OR tags NOT LIKE 'v1:%')
   AND (tags IS NULL OR tags NOT ILIKE '%source:%');

-- Optional: count how many encrypted rows were skipped, so you can decide
-- whether a Node-side backfill is worth wiring up.
SELECT COUNT(*) AS encrypted_rows_skipped
  FROM transactions
 WHERE user_id   = :'user_id'
   AND account_id = ANY(string_to_array(:'account_ids', ',')::int[])
   AND date BETWEEN :'from_date' AND :'to_date'
   AND tags LIKE 'v1:%';

-- COMMIT;     -- ← uncomment after the SELECTs look right
-- ROLLBACK;
