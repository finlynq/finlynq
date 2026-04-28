-- Drop the legacy per-pair fx_rates table.
--
-- Background: scripts/migrate-fx-rates-canonical.sql renamed the old shape
-- (user_id, from_currency, to_currency, rate) to fx_rates_legacy and built
-- a fresh USD-anchored fx_rates. The legacy table was kept as a one-cycle
-- safety net to compare values during the rollout. After ~2 weeks of
-- stable prod operation it can be dropped — the canonical fx_rates is the
-- only authoritative source.
--
-- Idempotent. Safe to re-run. The `IF EXISTS` guards on tables that have
-- already been dropped on a previous run.

DROP TABLE IF EXISTS fx_rates_legacy;
