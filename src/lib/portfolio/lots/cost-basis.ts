/**
 * Lot-based cost figures per holding, for readers that follow the user's
 * cost-basis method. SERVER ONLY — reaches `db`.
 *
 * `loadLotCostByHolding` returns null when the user is on the simple method,
 * so a caller writes one line (`costMetrics(tallies, lots?.get(id))`) and gets
 * the right figures either way. Cash sleeves are left out: they follow the
 * ledger, as on the Portfolio page.
 */

import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { todayISO } from "@/lib/utils/date";
import type { LotCost } from "../cost-metrics";
import { isLotsEnabledForUser, loadMetricsForUser } from "./read";

/**
 * Holding id -> lot figures, in the holding's own currency. Null = simple method.
 * With `reportingCurrency`, each entry also carries `costBasisReporting`: the
 * held lots' cost at the rate on each lot's own open date.
 */
export async function loadLotCostByHolding(
  userId: string,
  dek: Buffer | null,
  opts?: { reportingCurrency?: string },
): Promise<Map<number, LotCost> | null> {
  if (!(await isLotsEnabledForUser(userId))) return null;

  const reportingCurrency = opts?.reportingCurrency;
  const [lotMetrics, cashRows] = await Promise.all([
    loadMetricsForUser({
      userId,
      dek,
      asOfDate: todayISO(),
      // Cost basis and realized gain are price-independent; an empty price map
      // skips the quotes.
      prices: new Map(),
      reportingCurrency,
    }),
    db
      .select({ id: schema.portfolioHoldings.id })
      .from(schema.portfolioHoldings)
      .where(and(eq(schema.portfolioHoldings.userId, userId), eq(schema.portfolioHoldings.isCash, true)))
      .all(),
  ]);
  const cash = new Set(cashRows.map((r) => r.id));

  const out = new Map<number, LotCost>();
  for (const lm of lotMetrics) {
    if (cash.has(lm.holdingId)) continue;
    out.set(lm.holdingId, {
      qty: lm.qty,
      costBasis: lm.costBasis,
      realizedGain: lm.realizedGainAllTime,
      ...(reportingCurrency ? { costBasisReporting: lm.costBasisReporting } : {}),
    });
  }
  return out;
}
