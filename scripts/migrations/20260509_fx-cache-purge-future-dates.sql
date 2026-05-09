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

DELETE FROM fx_rates WHERE date::date > CURRENT_DATE;
