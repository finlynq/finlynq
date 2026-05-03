/**
 * Resolve the user's "Dividends" category id for portfolio aggregators.
 *
 * Why this exists: every portfolio aggregator (REST `/api/portfolio/overview`,
 * MCP HTTP `accumulate()` / `analyze_holding`, MCP stdio `analyze_holding`)
 * historically classified dividend payouts with a brittle heuristic —
 * `quantity == 0 AND amount > 0`. That guess silently dropped:
 *
 *   - dividend reinvestments (qty>0, amt<0 — re-classified as buys)
 *   - withholding tax / negative-correction entries (qty=0, amt<0 — fell
 *     through every branch and silently disappeared from `dividendsReceived`)
 *
 * The fix is to match `transactions.category_id` against the user's
 * "Dividends" (or "Dividend") category id, mirroring the user's mental
 * model and aligning with [auto-categorize.ts:195](src/lib/auto-categorize.ts)
 * which already routes "dividend"-payee transactions to that category.
 *
 * Issue #84.
 */

import { sql } from "drizzle-orm";
import { nameLookup } from "./crypto/encrypted-columns";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbLike = { execute: (q: ReturnType<typeof sql>) => Promise<any> };

/**
 * Look up the user's "Dividends" category id. Returns `null` if the user has
 * no such category — aggregators then sum `dividendsReceived` to 0.
 *
 * Stream D Phase 4 (2026-05-03): the plaintext `categories.name` column is
 * physically dropped. Lookup is HMAC-only via `name_lookup`. Without a DEK
 * (e.g. stdio MCP) the function returns `null` — aggregators degrade to 0
 * dividends (acceptable, since stdio can't compute the HMAC anyway).
 *
 * Returns the first matching id from candidates `["Dividends", "Dividend"]`
 * in that order — same fallback ladder as `pickInvestmentCategoryByPayee()`.
 */
export async function resolveDividendsCategoryId(
  db: DbLike,
  userId: string,
  dek: Buffer | null,
): Promise<number | null> {
  if (!dek) return null;
  const candidates = ["Dividends", "Dividend"];
  for (const name of candidates) {
    const lookup = nameLookup(dek, name);
    const result = await db.execute(sql`
      SELECT id FROM categories
      WHERE user_id = ${userId}
        AND name_lookup = ${lookup}
      LIMIT 1
    `);
    // Normalize result shape (pg drivers return { rows: [...] }, some adapters
    // return the array directly).
    let rows: Array<{ id: number }> = [];
    if (result && typeof result === "object") {
      if ("rows" in result && Array.isArray((result as { rows: unknown }).rows)) {
        rows = (result as { rows: Array<{ id: number }> }).rows;
      } else if (Array.isArray(result)) {
        rows = result as Array<{ id: number }>;
      }
    }
    if (rows.length > 0) {
      return Number(rows[0].id);
    }
  }
  return null;
}
