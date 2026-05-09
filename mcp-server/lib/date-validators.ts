// Strict date / period validators for MCP HTTP + stdio tool schemas.
//
// Background: every MCP tool that takes a date param historically used
// `z.string()` with no format constraint. That accepted calendar-invalid
// garbage like 'not-a-date' or '2025-02-29', which (a) crashed
// `generateAmortizationSchedule` (Invalid time value) and poisoned
// `list_loans` / `get_loan_amortization` / `get_debt_payoff_plan`, and (b)
// let `preview_bulk_update({ changes: { date: 'not-a-date' } })` mint a
// confirmation token whose `execute_bulk_update` would silently corrupt
// every matched row.
//
// The two-layer pattern (regex + .refine round-trip) is intentional —
// `Date.parse('2025-02-29')` returns a valid timestamp because JS rolls
// Feb 29 into Mar 1 silently, so a naive `!isNaN(...)` check fails open.
// The round-trip via `toISOString().slice(0, 10) === s` catches that.
//
// See pf-app/docs/architecture/mcp.md and CLAUDE.md "Load-bearing gotchas".

import { z } from "zod";

const YMD_REGEX = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const YM_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Strict YYYY-MM-DD validator.
 *
 * Regex first (cheap, catches obvious garbage and out-of-range months/days)
 * then a `.refine` round-trip (catches Feb 30, non-leap Feb 29, etc. that
 * JS's `Date` constructor would silently roll forward).
 */
export const ymdDate = z
  .string()
  .regex(YMD_REGEX, "expected YYYY-MM-DD")
  .refine((s) => {
    const d = new Date(s + "T00:00:00Z");
    if (Number.isNaN(d.getTime())) return false;
    // Round-trip: 2025-02-29 -> 2025-03-01 fails this check.
    return d.toISOString().slice(0, 10) === s;
  }, "invalid calendar date");

/**
 * Strict YYYY-MM validator (used by `set_budget` / `get_budget_summary`).
 */
export const ymPeriod = z.string().regex(YM_REGEX, "expected YYYY-MM");

/**
 * Defensive parse for read paths that may encounter legacy bad rows
 * (e.g. loans stored before the validator landed). Returns `null` instead
 * of throwing `Invalid time value` — callers surface a `dataIntegrity`
 * marker per row so one bad row doesn't poison the whole list.
 */
export function parseYmdSafe(s: string | null | undefined): Date | null {
  if (!s) return null;
  if (!YMD_REGEX.test(s)) return null;
  const d = new Date(s + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return null;
  if (d.toISOString().slice(0, 10) !== s) return null;
  return d;
}

/**
 * Boolean variant of `parseYmdSafe` for callers that just need a guard.
 */
export function isValidYmd(s: string | null | undefined): boolean {
  return parseYmdSafe(s) !== null;
}
