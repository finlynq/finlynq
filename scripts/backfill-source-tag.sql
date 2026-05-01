-- ─────────────────────────────────────────────────────────────────────────────
--  backfill-source-tag.sql — issue #62 follow-up to issue #33
-- ─────────────────────────────────────────────────────────────────────────────
--
--  Purpose
--  -------
--  Rewrite institution-specific `source:wealthposition` and `source:ibkr`
--  tags in `transactions.tags` to format-based tags (`source:csv`,
--  `source:ibkr-xml`). The format-tag vocabulary lives in
--  pf-app/src/lib/tx-source.ts (FORMAT_TAGS) and is mirrored in
--  packages/import-connectors/src/types.ts.
--
--  Why
--  ---
--  Issue #62 dropped per-row institution tags — institution name already
--  lives on the account, and the format-based vocabulary (csv | excel | pdf
--  | ofx | qfx | ibkr-xml | email) scales as more connectors land. New rows
--  carry the format tag automatically; this script handles the historical
--  rows that pre-date the rewrite.
--
--  Defaults
--  --------
--    `source:wealthposition` → `source:csv`        (WP exports as CSV today)
--    `source:ibkr`           → `source:csv`        (most in-the-wild rows
--                                                   were CSV-imported per
--                                                   user reports; if you
--                                                   know a specific batch
--                                                   came from XML, run
--                                                   manually with the
--                                                   `:override_to`
--                                                   parameter set to
--                                                   `ibkr-xml`)
--
--  Scope (you fill these in)
--  -------------------------
--    :user_id     — the Finlynq user id (uuid string)
--    :from_tag    — old tag, with the `source:` prefix, e.g. 'source:wealthposition'
--    :to_tag      — new tag, with the `source:` prefix, e.g. 'source:csv'
--                   (must be one of source:csv | source:excel | source:pdf
--                    | source:ofx | source:qfx | source:ibkr-xml | source:email)
--
--  IMPORTANT — encryption caveat
--  -----------------------------
--  Most managed-cloud / privacy-hardened deployments store transactions.tags
--  as envelope-encrypted ciphertext (`v1:...`). Plain SQL cannot re-encrypt
--  in place without the user's DEK, so this script SKIPS encrypted rows
--  (`tags LIKE 'v1:%'`). For those, re-import the source files through the
--  app to pick up the new tags, or write a Node-side backfill that unwraps
--  the DEK per-user (out of scope here).
--
--  Idempotency
--  -----------
--  Re-running this script does nothing on the second run — the WHERE clause
--  filters on `tags ~ <from_tag>` and the rewrite removes that token, so the
--  filter no longer matches.
--
--  Run as a transaction. Inspect the SELECT preview before committing.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── Preview what would change. Run this first; sanity-check the count + a
--    handful of rows match the connector you're rewriting.
SELECT id, date, account_id, payee, tags
  FROM transactions
 WHERE user_id = :'user_id'
   AND tags NOT LIKE 'v1:%'
   AND (
        tags = :'from_tag'
     OR tags LIKE :'from_tag' || ',%'
     OR tags LIKE '%,' || :'from_tag' || ',%'
     OR tags LIKE '%,' || :'from_tag'
   )
 ORDER BY date, id
 LIMIT 50;

-- ── Apply the rewrite. Three cases:
--      1. tags == :from_tag             → set to :to_tag
--      2. tags begins with :from_tag,   → replace prefix
--      3. tags contains ,:from_tag      → replace embedded
--    All three handled by the regex_replace below — boundary-anchored on
--    commas so we don't accidentally rewrite a substring of another tag.
UPDATE transactions
   SET tags = trim(BOTH ',' FROM
                   regexp_replace(
                     ',' || tags || ',',
                     ',' || :'from_tag' || ',',
                     ',' || :'to_tag' || ',',
                     'g'
                   ))
 WHERE user_id = :'user_id'
   AND tags NOT LIKE 'v1:%'
   AND (
        tags = :'from_tag'
     OR tags LIKE :'from_tag' || ',%'
     OR tags LIKE '%,' || :'from_tag' || ',%'
     OR tags LIKE '%,' || :'from_tag'
   );

-- ── De-dup if both old and new tags coexisted on the same row (defensive).
UPDATE transactions
   SET tags = (
     SELECT string_agg(t, ',' ORDER BY ord)
       FROM (
         SELECT DISTINCT t, MIN(ord) AS ord
           FROM unnest(string_to_array(tags, ',')) WITH ORDINALITY AS u(t, ord)
          GROUP BY t
       ) AS d
   )
 WHERE user_id = :'user_id'
   AND tags NOT LIKE 'v1:%'
   AND tags LIKE '%' || :'to_tag' || '%' || :'to_tag' || '%';

-- ── Count encrypted rows that were skipped, so you can decide whether a
--    Node-side backfill is worth wiring up.
SELECT COUNT(*) AS encrypted_rows_skipped
  FROM transactions
 WHERE user_id = :'user_id'
   AND tags LIKE 'v1:%';

-- COMMIT;     -- ← uncomment after the SELECTs look right
-- ROLLBACK;
