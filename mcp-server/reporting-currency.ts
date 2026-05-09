/**
 * MCP helper for resolving the user's reporting currency.
 *
 * Tools that aggregate amounts (net worth, spending, balances) accept an
 * optional `reportingCurrency` argument. When omitted, fall back to the
 * user's saved `display_currency` setting; otherwise to "CAD".
 *
 * Used by the HTTP MCP transport (PostgreSQL via Drizzle). The stdio
 * MCP transport has its own slimmer resolver in register-core-tools.ts
 * because it queries through pg-compat with positional `?` placeholders.
 */

import { sql } from "drizzle-orm";
import { roundMoney } from "../src/lib/money";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = { execute: (q: any) => Promise<any> };

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: Array<Record<string, unknown>> }).rows;
  }
  return [];
}

const DEFAULT_REPORTING_CURRENCY = "CAD";

/**
 * Resolve the reporting currency for a tool call:
 *   - explicit param (uppercased) wins
 *   - else user's settings.display_currency (uppercased)
 *   - else "CAD"
 */
export async function resolveReportingCurrency(
  db: AnyDb,
  userId: string,
  param: string | undefined | null,
): Promise<string> {
  if (param && /^[A-Z]{3,4}$/i.test(param)) return param.toUpperCase();
  try {
    const r = await db.execute(sql`
      SELECT value FROM settings
       WHERE user_id = ${userId} AND key = 'display_currency'
       LIMIT 1
    `);
    const rows = rowsOf(r);
    const v = rows[0]?.value;
    if (typeof v === "string" && v.trim()) return v.trim().toUpperCase();
  } catch {
    // Best effort — fall through to default.
  }
  return DEFAULT_REPORTING_CURRENCY;
}

/**
 * Aggregate a set of native-currency amounts into a single reporting-currency
 * total using the round-once-at-end semantic.
 *
 * Issue #210 — `get_net_worth.total.net.amount` and `get_account_balances
 * .totalReporting.amount` previously disagreed by 1c on identical state because
 * one rounded each per-account leg before summing while the other accumulated
 * un-rounded then rounded the grand total. With dozens of multi-currency
 * accounts a 1c drift was the expected behavior — exactly the kind of trust
 * leak we want to crush at the response boundary.
 *
 * Contract:
 *   - Callers MUST NOT round per-item before summing. Pass raw `amount` +
 *     `currency` and the helper handles rounding once at the end.
 *   - `getFx(from, to)` is async (cached lookups OK). Same FX instant for
 *     every leg in one call (today's rate).
 *   - Return shape: `{ totalReporting, perItem: [{ ...item, fx, reportingAmount }] }`
 *     where `reportingAmount` is the per-item display value (rounded for
 *     display, NOT used in the total calculation).
 */
export async function aggregateInReporting<T extends { amount: number | string; currency: string | null }>(
  items: T[],
  reportingCurrency: string,
  getFx: (from: string, to: string) => Promise<number>,
): Promise<{
  totalReporting: number;
  perItem: Array<T & { fx: number; reportingAmount: number }>;
}> {
  // Pre-fetch FX once per (from→to) pair. Multiple items in the same currency
  // share a single getFx call.
  const fxCache = new Map<string, number>();
  const reporting = reportingCurrency.toUpperCase();
  for (const it of items) {
    const ccy = String(it.currency ?? reporting).toUpperCase();
    if (!fxCache.has(ccy)) {
      fxCache.set(ccy, await getFx(ccy, reporting));
    }
  }

  // Accumulate raw (un-rounded) reporting amounts; round only the grand total.
  let totalRaw = 0;
  const perItem = items.map((it) => {
    const ccy = String(it.currency ?? reporting).toUpperCase();
    const fx = fxCache.get(ccy) ?? 1;
    const rawAmount = Number(it.amount);
    const reportingRaw = rawAmount * fx;
    totalRaw += reportingRaw;
    return {
      ...it,
      fx,
      // Per-item display value — rounded for the response shape but NOT
      // used in `totalRaw` (that already aggregated the un-rounded sum).
      reportingAmount: roundMoney(reportingRaw, reporting),
    };
  });

  return {
    totalReporting: roundMoney(totalRaw, reporting),
    perItem,
  };
}
