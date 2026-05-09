-- Issue #206 — purge poisoned future-dated FX cache rows.
--
-- Background: before the fix, getRateToUsdDetailed() persisted the result of a
-- "today" Yahoo fetch under any requested date — including future dates. Those
-- rows then outranked every legitimate historical row in findNearestCached
-- (ORDER BY date DESC LIMIT 1) and served as a stale fallback for every miss.
--
-- The fix gates writeCached on date <= today AND restricts findNearestCached
-- to date <= today. This migration cleans up rows already written before the
-- fix landed. It is safe to run repeatedly (idempotent — DELETE on a predicate
-- with no rows is a no-op).
--
-- fx_rates is a global table (no user_id), so this runs once per env, not
-- per user. fx_overrides is left alone — those are user-entered with intent.
--
-- Follow-up (fix-mode, 2026-05-09): `fx_rates.date` is declared as TEXT in
-- src/db/schema-pg.ts (column comment "YYYY-MM-DD"). Bad rows whose `date`
-- value is not a valid YYYY-MM-DD string have leaked into prod/dev — the
-- direct-cast `date::date > CURRENT_DATE` fails fast on the first malformed
-- row and aborts the whole migration transaction (deploy stays on the OLD
-- service + OLD schema). Pre-filter non-parseable rows BEFORE the cast so
-- the cast only sees well-formed values. Both DELETEs are idempotent
-- (re-running on a clean table is a no-op). Root-cause overlap with #213.

-- Step 1: drop rows with malformed `date` values. The regex enforces a strict
-- ISO-8601 calendar-date shape with month 01-12 and day 01-31; anything else
-- (empty string, "not-a-date", "2026-99-99", timestamps with time component,
-- etc.) is unusable for the nearest-cached lookup and gets purged.
-- Day-of-month edge cases ("2026-02-30") aren't excluded by the regex but
-- are extremely unlikely from any code path that produced these rows; the
-- step-2 cast handles all remaining values that are now month/day-bounded.
DELETE FROM fx_rates
WHERE date !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$';

-- Step 2: drop future-dated rows. Safe now that step 1 removed every row
-- whose `date` can't survive the cast.
DELETE FROM fx_rates WHERE date::date > CURRENT_DATE;
