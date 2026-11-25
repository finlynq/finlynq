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
  // Fields added after a snapshot was frozen (same schema version, newer
  // engine) get neutral defaults, so every reader can rely on them: a phase-2
  // snapshot has no toInvestments / purchases / borrowed / withdrawn totals,
  // and yearlyView crashed summing them (2026-11-25).
  const n = r.months.length;
  const zeros = () => new Array<number>(n).fill(0);
  const t = r.totals as Partial<ForecastResult["totals"]>;
  const arr = (v: unknown) => (Array.isArray(v) && v.length === n ? (v as number[]) : zeros());
  return {
    ...r,
    totals: {
      income: arr(t.income),
      expense: arr(t.expense),
      debtPayment: arr(t.debtPayment),
      interest: arr(t.interest),
      net: arr(t.net),
      drawn: arr(t.drawn),
      toInvestments: arr(t.toInvestments),
      purchases: arr(t.purchases),
      borrowed: arr(t.borrowed),
      withdrawn: arr(t.withdrawn),
    },
    deflator: Array.isArray(r.deflator) && r.deflator.length === n ? r.deflator : new Array<number>(n).fill(1),
    loans: r.loans ?? [],
    events: r.events ?? [],
    birthYear: r.birthYear ?? null,
    retirement: r.retirement ?? null,
    milestones: r.milestones ?? [],
    warnings: r.warnings ?? [],
    blankLines: r.blankLines ?? [],
  } as ForecastResult;
}
