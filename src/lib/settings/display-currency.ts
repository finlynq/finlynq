/**
 * FINLYNQ-301 phase 4 — the single writer for `settings.display_currency`.
 *
 * Extracted verbatim from `PUT /api/settings/display-currency` so both that
 * route AND the display-currency decision prompt persist through one code path:
 * upsert on `(key, userId)`, then `recomputeReportingAmounts` only when the
 * value actually changed (currency rework Phase 3). The default is USD, the
 * app-wide FINLYNQ-183 default (NOT the old CAD).
 *
 * SERVER ONLY. Accepts the global `db` or a transaction client `tx`, so the
 * answer route can run this inside the same transaction as its ack upsert.
 */

import { and, eq } from "drizzle-orm";
import type { DrizzleDb } from "@/db";
import { schema } from "@/db";
import { recomputeReportingAmounts } from "@/lib/fx/reporting-amount";

type TxClient = Parameters<Parameters<DrizzleDb["transaction"]>[0]>[0];
type DbOrTx = DrizzleDb | TxClient;

export const DEFAULT_DISPLAY_CURRENCY = "USD";

/**
 * Persist a user's display currency. Idempotent. Returns whether the value
 * actually changed (drives the fire-and-forget reporting-amount recompute,
 * exactly as the PUT route did). Does NOT validate the currency against the
 * supported list — callers that need that (the PUT route) pre-check it.
 */
export async function setDisplayCurrency(
  db: DbOrTx,
  userId: string,
  currencyRaw: string,
): Promise<{ changed: boolean }> {
  const currency = currencyRaw.trim().toUpperCase();

  const prior = await db
    .select({ value: schema.settings.value })
    .from(schema.settings)
    .where(
      and(
        eq(schema.settings.key, "display_currency"),
        eq(schema.settings.userId, userId),
      ),
    )
    .limit(1);
  const changed =
    (prior[0]?.value ?? DEFAULT_DISPLAY_CURRENCY).toUpperCase() !== currency;

  await db
    .insert(schema.settings)
    .values({ key: "display_currency", userId, value: currency })
    .onConflictDoUpdate({
      target: [schema.settings.key, schema.settings.userId],
      set: { value: currency },
    });

  // Currency rework Phase 3 — re-derive every transaction's stored reporting
  // amount at historical rates. Fire-and-forget: the persistent Node server
  // keeps running it, `reporting_recompute_status` tracks progress, and reports
  // stay correct meanwhile via the on-the-fly fallback. Guarded against
  // concurrent runs. Uses the global `db` internally, so it is safe to fire
  // from inside a caller's transaction.
  if (changed) {
    void recomputeReportingAmounts(userId, currency).catch((err) => {
      console.error("[display-currency] reporting recompute failed:", err);
    });
  }

  return { changed };
}
