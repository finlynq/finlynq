-- Issue #231 follow-up — purge poisoned fx_rate cache rows written before the
-- weekend/holiday walkback fix landed (PR #240).
--
-- Background: before PR #240, getRateToUsdDetailed() persisted Yahoo's
-- "today's spot" payload under the requested historical date when the lookup
-- fell on a weekend or market-closed day. Those rows survive in fx_rates as
-- (currency, requested_date, today's_spot, source='yahoo'), and findCached
-- short-circuits at step 2 of getRateToUsdDetailed before the new walkback
-- code in fetchYahooRateToUsd ever runs. The validator's repro from #231 hit
-- this exactly: get_fx_rate(USD, CAD, "2020-03-15") returned today's spot
-- (1.36761488) instead of the Friday 2020-03-13 close (~1.39).
--
-- The fix is to drop every historical-date cache row so the next lookup for
-- each (currency, date) pair re-fetches via the corrected walkback path.
-- Cardinality is low (one row per (currency, date) ever requested in the
-- pre-fix era), so the re-fetch cost is bounded by usage. Rows for date >=
-- CURRENT_DATE are LEFT IN PLACE — the future-dated transaction settle path
-- (cron at src/lib/cron/settle-future-fx.ts) writes those legitimately and
-- the today-row was correct when written.
--
-- This is idempotent (DELETE on a clean predicate is a no-op) and follows
-- the #206 cache-purge migration pattern in
-- scripts/migrations/20260509_fx-cache-purge-future-dates.sql.
--
-- fx_rates is global (no user_id), so this runs once per env. fx_overrides
-- is left alone — those are user-entered with intent.

-- Step 1: drop rows with malformed `date` values (defensive — same shape as
-- the #206 migration; fx_rates.date is TEXT and we've seen non-ISO leakage
-- from earlier code paths). The regex enforces a strict YYYY-MM-DD shape so
-- the step-2 cast can't abort the transaction on a bad row.
DELETE FROM fx_rates
WHERE date !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$';

-- Step 2: purge every historical-date row. Forces a re-fetch via the new
-- walkback path on next request. Today's and future-dated rows are left in
-- place (the today-row is correct; future-dated rows are owned by the
-- settle-future-fx cron).
DELETE FROM fx_rates WHERE date::date < CURRENT_DATE;
