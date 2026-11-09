-- Drop FX rates that hold Yahoo's 4-decimal ROUNDED quote (2026-11-09, GH #397).
--
-- The live branch of fx-service stored `meta.regularMarketPrice`, which Yahoo
-- rounds to 4 decimal places on every currency quote, from the first live rate
-- in May 2026 until this release. For a currency worth under 0.001 USD that is
-- a large error: IDR (≈0.0000554) and UZS (≈0.0000834) were stored as 0.0001,
-- i.e. "1 USD = 10,000" instead of ~18,000 / ~12,000; COP, KRW and ARS were
-- off by 5-8%. The live branch now reads the full-precision close[].
--
-- Only rows UNDER 0.001 that sit exactly on 4 decimals are deleted (measured
-- on prod: 261 rows — IDR 108, UZS 81, COP 58, ARS 12, KRW 2). A real close carries
-- full float precision and never lands there; the correct rows for these
-- currencies are kept so a Yahoo timeout still has a near-correct stale rate
-- to fall back on instead of the engine's rate-1 last resort. The app refetches
-- each deleted date on the next request that needs it (past dates through the
-- historical branch, which has always read close[]).
--
-- fx-service's findCached applies the same test (isRoundedSmallRate), so a
-- rounded row the OLD process writes between this migration and the restart
-- is refetched rather than trusted. Rows under 0.001 come only from Yahoo
-- today; the source filter keeps it that way if crypto rates ever land here.
--
-- Not done here: transactions.reporting_amount and portfolio snapshots built
-- from these rates are not recomputed by this file. Idempotent.

DELETE FROM fx_rates
WHERE source = 'yahoo'
  AND rate_to_usd > 0
  AND rate_to_usd < 0.001
  AND rate_to_usd::numeric = round(rate_to_usd::numeric, 4);
