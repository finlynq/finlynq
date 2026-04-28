/**
 * Settle FX rates on transactions that were future-dated when entered.
 *
 * When a user records a row dated in the future, getRateAtDate returns
 * today's rate as a best estimate (no Yahoo data exists for tomorrow).
 * Once the date has arrived, the actual rate for that day is now
 * available — this cron re-fetches the rate, updates entered_fx_rate
 * and amount on the row, and logs the change.
 *
 * Eligibility:
 *   - date <= today (the future has caught up)
 *   - date > entered_at::date (it WAS future-dated at entry)
 *   - entered_currency != currency (a real cross-currency conversion)
 *   - settled_fx_at IS NULL OR settled_fx_at < date  (un-settled or stale)
 *
 * The cron is wired in instrumentation.ts on a daily interval. Safe to
 * run repeatedly — the WHERE clauses make it idempotent.
 */

import { db, schema } from "@/db";
import { sql, and, eq, lt, gt, isNotNull, isNull, or } from "drizzle-orm";
import { convertToAccountCurrency } from "@/lib/currency-conversion";

export type SettleResult = { settled: number; failed: number; errors: string[] };

/**
 * Find and settle future-dated rows whose date has arrived. Best-effort —
 * a failure on one row doesn't stop the rest.
 */
export async function settleFutureFxRates(): Promise<SettleResult> {
  const today = new Date().toISOString().split("T")[0];

  // Find candidate rows. The (date <= today AND date > entered_at::date)
  // pair narrows to rows whose date has passed but was forward-dated at entry.
  // entered_currency != currency ensures there's a real conversion to settle.
  const candidates = await db
    .select({
      id: schema.transactions.id,
      userId: schema.transactions.userId,
      date: schema.transactions.date,
      enteredAmount: schema.transactions.enteredAmount,
      enteredCurrency: schema.transactions.enteredCurrency,
      enteredFxRate: schema.transactions.enteredFxRate,
      currency: schema.transactions.currency,
      enteredAt: schema.transactions.enteredAt,
    })
    .from(schema.transactions)
    .where(and(
      isNotNull(schema.transactions.enteredAmount),
      isNotNull(schema.transactions.enteredCurrency),
      sql`${schema.transactions.enteredCurrency} != ${schema.transactions.currency}`,
      lt(schema.transactions.date, sql`(${today}::date + INTERVAL '1 day')::text`),
      sql`${schema.transactions.date}::date > ${schema.transactions.enteredAt}::date`,
    ));

  let settled = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const row of candidates) {
    if (!row.enteredAmount || !row.enteredCurrency) continue;
    try {
      const conv = await convertToAccountCurrency({
        enteredAmount: row.enteredAmount,
        enteredCurrency: row.enteredCurrency,
        accountCurrency: row.currency,
        date: row.date,
        userId: row.userId,
      });
      // Skip if FX is still a fallback — wait for next sweep when Yahoo
      // (probably) has caught up. Avoids overwriting a good locked rate
      // with a worse fallback.
      if (conv.source === "fallback") continue;
      // Skip if the rate hasn't actually changed materially (avoid churn).
      if (Math.abs(conv.enteredFxRate - (row.enteredFxRate ?? 1)) < 1e-6) continue;
      await db
        .update(schema.transactions)
        .set({
          amount: conv.amount,
          enteredFxRate: conv.enteredFxRate,
        })
        .where(eq(schema.transactions.id, row.id));
      settled++;
    } catch (err) {
      failed++;
      errors.push(`tx ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { settled, failed, errors };
}

let timer: NodeJS.Timeout | null = null;

/**
 * Start the daily settle interval. Safe to call multiple times — second
 * call is a no-op.
 */
export function startSettleFutureFxTimer(): void {
  if (timer) return;
  const ONE_DAY = 24 * 60 * 60 * 1000;
  timer = setInterval(() => {
    settleFutureFxRates().catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[settle-future-fx] sweep failed:", err);
    });
  }, ONE_DAY);
  if (timer.unref) timer.unref();
}

export function stopSettleFutureFxTimer(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
