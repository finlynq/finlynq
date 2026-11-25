/**
 * Reading a saved snapshot's result (plan section 8a). Pure, client-safe.
 *
 * A snapshot is stored as the result JSON of the day it was frozen. When the
 * result shape changes (`FORECAST_RESULT_SCHEMA_VERSION` bumps), old snapshots
 * are read through `upgradeForecastResult`, never recomputed. Version 1 is the
 * first shape, so today this only checks the essentials are there.
 */
import { FORECAST_RESULT_SCHEMA_VERSION } from "./config";
import type { ForecastResult } from "./types";

/** Largest result JSON a snapshot may hold (50 years monthly with many lines fits easily). */
export const MAX_SNAPSHOT_BYTES = 3_000_000;
export const MAX_SNAPSHOTS_PER_USER = 50;

export function upgradeForecastResult(raw: unknown): ForecastResult | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<ForecastResult>;
  if (typeof r.resultSchemaVersion !== "number" || r.resultSchemaVersion > FORECAST_RESULT_SCHEMA_VERSION) return null;
  if (!Array.isArray(r.months) || !Array.isArray(r.lines) || !r.balances || !r.totals || typeof r.currency !== "string") return null;
  // Future: if (r.resultSchemaVersion === 1) r = upgradeV1toV2(r) …
  return r as ForecastResult;
}
