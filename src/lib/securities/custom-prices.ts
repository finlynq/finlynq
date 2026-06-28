/**
 * Manual / custom security pricing — shared read helpers.
 *
 * A security with `price_source = 'manual'` is EXCLUDED from the Yahoo/CoinGecko
 * price API; its market value comes from the user-entered `custom_security_prices`
 * marks instead. Each mark is an effective-from `(date, price)` point in the
 * security's currency. The "effective price at date D" is the mark with the latest
 * `date <= D` (forward-fill / step function); before the first mark a holding
 * values at 0 (the product-owner-locked "Zero" fallback).
 *
 * Used by BOTH market-price surfaces — the shared core `valueHoldingsAtDate`
 * (holdings-value.ts) and `/api/portfolio/overview` — so manual pricing is honored
 * everywhere that values holdings.
 */

import { and, asc, eq, inArray } from "drizzle-orm";

import { db, schema } from "@/db";

export type CustomPricePoint = {
  date: string; // YYYY-MM-DD
  price: number;
  currency: string;
};

/**
 * The effective custom price at `date` — the latest mark on-or-before `date`.
 * Returns `null` when `points` is empty or every mark is strictly after `date`
 * (i.e. before the first mark). `points` MUST be sorted ascending by `date`
 * (loadCustomPriceMap guarantees this).
 *
 * Pure — no DB / no DEK. Unit-tested.
 */
export function effectivePriceAtDate(
  points: ReadonlyArray<{ date: string; price: number }>,
  date: string,
): number | null {
  let chosen: number | null = null;
  for (const p of points) {
    if (p.date <= date) chosen = p.price;
    else break; // ascending — the rest are all after `date`
  }
  return chosen;
}

/**
 * Load every manual price mark for the user's manual securities, grouped by
 * `security_id` and sorted ascending by `date`. Pass `securityIds` to scope the
 * read to the involved securities (e.g. the manual holdings on screen); omit it
 * to load all of the user's marks. Returns an empty map when there are none, so
 * callers with no manual securities stay byte-identical.
 *
 * Owner-scoped (`user_id`). DEK-free — prices are plain numbers.
 */
export async function loadCustomPriceMap(
  userId: string,
  securityIds?: number[],
): Promise<Map<number, CustomPricePoint[]>> {
  const out = new Map<number, CustomPricePoint[]>();
  if (securityIds && securityIds.length === 0) return out;

  const where =
    securityIds && securityIds.length > 0
      ? and(
          eq(schema.customSecurityPrices.userId, userId),
          inArray(schema.customSecurityPrices.securityId, securityIds),
        )
      : eq(schema.customSecurityPrices.userId, userId);

  const rows = await db
    .select({
      securityId: schema.customSecurityPrices.securityId,
      date: schema.customSecurityPrices.date,
      price: schema.customSecurityPrices.price,
      currency: schema.customSecurityPrices.currency,
    })
    .from(schema.customSecurityPrices)
    .where(where)
    .orderBy(asc(schema.customSecurityPrices.securityId), asc(schema.customSecurityPrices.date));

  for (const r of rows) {
    const arr = out.get(r.securityId) ?? [];
    arr.push({ date: r.date, price: Number(r.price), currency: r.currency });
    out.set(r.securityId, arr);
  }
  return out;
}
