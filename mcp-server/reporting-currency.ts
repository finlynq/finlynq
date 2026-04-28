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
