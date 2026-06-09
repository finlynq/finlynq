/**
 * Currency rework Phase 3 (2026-06-06) — per-transaction reporting amount.
 *
 * `transactions.reporting_amount` is `amount` (account currency) converted to
 * the user's display/reporting currency at THIS row's `date` historical FX
 * rate, locked at write time. Flow reports (trends / yoy / income-statement
 * income+expense / tax-summary) SUM it directly instead of re-converting at
 * today's rate on every load. When the user switches display currency, a
 * background job (`recomputeReportingAmounts`) re-derives every row at
 * historical rates; until it catches up, reports fall back to on-the-fly
 * conversion of `amount` for rows whose `reporting_currency` != the current
 * display currency.
 *
 * Triangulates through USD, mirroring `convertToAccountCurrency`:
 *   rate(account → reporting) = rateToUsd[account] / rateToUsd[reporting].
 */

import { db, schema } from "@/db";
import { and, eq, sql } from "drizzle-orm";
import { getRateToUsdDetailed, convertWithRateMap } from "@/lib/fx-service";

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Flow-figure conversion (FINLYNQ-123) — single source of truth for converting
 * a per-`(currency, reporting_currency)` aggregate slice to the user's display
 * currency. Prefers the STORED historical `reporting_amount` when the row's
 * `reporting_currency` already matches the display currency (locked at write
 * time at each transaction's date rate); otherwise falls back to an on-the-fly
 * CURRENT-rate conversion of the raw `amount` via the rate map.
 *
 * This is the exact convention the dashboard income/expense + spending tiles
 * use (`convertGroup` in src/app/api/dashboard/route.ts, Phase 3). Use it for
 * EVERY flow surface (Weekly Recap, Spending Insights, Reports) so the same
 * period reports the same display-currency number everywhere. Do NOT hand-roll
 * a `SUM(amount)` cross-currency sum under one currency label.
 *
 * @param displayCurrency caller-resolved display currency (any case).
 * @param rateMap         current-rate map from `getRateMap(displayCurrency)`.
 */
export function convertReportingSlice(
  row: {
    currency: string | null;
    reportingCurrency: string | null;
    totalAmount: number | null;
    totalReporting: number | null;
  },
  displayCurrency: string,
  rateMap: Map<string, number>,
): number {
  const displayUpper = (displayCurrency ?? "").trim().toUpperCase();
  if (
    row.reportingCurrency &&
    row.reportingCurrency.toUpperCase() === displayUpper &&
    row.totalReporting != null
  ) {
    return row.totalReporting;
  }
  return convertWithRateMap(row.totalAmount ?? 0, row.currency ?? displayUpper, rateMap);
}

export type ReportingFields = {
  /** Currency `reportingAmount` is expressed in (the resolved display currency). */
  reportingCurrency: string;
  /** account currency → reportingCurrency rate at the transaction's date. */
  reportingRate: number;
  /** round2(amount × reportingRate). */
  reportingAmount: number;
};

/**
 * Resolve the historical account→reporting rate for a single row.
 *
 * Best-effort: returns `null` when a real rate is unavailable (either leg is a
 * `fallback` source, or a zero divisor) so the caller leaves the columns NULL
 * and the report falls back to on-the-fly conversion / the cron + self-heal
 * re-rate later. NEVER throws — a reporting-leg miss must not block a ledger
 * write.
 */
export async function computeReportingFields(opts: {
  userId: string;
  accountCurrency: string;
  amount: number;
  date: string;
  /** The resolved display/reporting currency to convert into. */
  reportingCurrency: string;
}): Promise<ReportingFields | null> {
  const accountCurrency = (opts.accountCurrency ?? "").trim().toUpperCase();
  const reportingCurrency = (opts.reportingCurrency ?? "").trim().toUpperCase();
  if (!accountCurrency || !reportingCurrency || !Number.isFinite(opts.amount)) return null;

  if (accountCurrency === reportingCurrency) {
    return { reportingCurrency, reportingRate: 1, reportingAmount: round2(opts.amount) };
  }

  try {
    const [acctUsd, repUsd] = await Promise.all([
      getRateToUsdDetailed(accountCurrency, opts.date, opts.userId),
      getRateToUsdDetailed(reportingCurrency, opts.date, opts.userId),
    ]);
    if (acctUsd.source === "fallback" || repUsd.source === "fallback" || repUsd.rate === 0) {
      return null;
    }
    const rate = acctUsd.rate / repUsd.rate;
    return { reportingCurrency, reportingRate: rate, reportingAmount: round2(opts.amount * rate) };
  } catch {
    return null;
  }
}

// ── In-flight guard (HMR-safe, mirrors the portfolio-snapshot rebuild guard) ──
function guardStore(): Set<string> {
  const g = globalThis as unknown as { __pfReportingRecomputeInFlight?: Set<string> };
  if (!g.__pfReportingRecomputeInFlight) g.__pfReportingRecomputeInFlight = new Set<string>();
  return g.__pfReportingRecomputeInFlight;
}

export function isReportingRecomputeInFlight(userId: string): boolean {
  return guardStore().has(userId);
}

export type RecomputeResult =
  | { ok: true; pairs: number; updated: number; skipped: number }
  | { ok: false; reason: "in_flight" };

/**
 * Re-derive `reporting_amount`/`reporting_currency`/`reporting_rate` for EVERY
 * transaction of `userId` into `targetCurrency` at each row's historical rate.
 *
 * Grouped by distinct (account currency, date) so we issue one cached rate
 * lookup + one UPDATE per group (not per row). Writes a one-row progress record
 * to `reporting_recompute_status` for the Settings toast. Guarded so a second
 * concurrent call no-ops. Best-effort: a group whose rate can't be resolved is
 * left untouched (reports fall back) and retried by the cron / next self-heal.
 */
export async function recomputeReportingAmounts(
  userId: string,
  targetCurrency: string,
): Promise<RecomputeResult> {
  const target = (targetCurrency ?? "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(target)) return { ok: true, pairs: 0, updated: 0, skipped: 0 };

  const store = guardStore();
  if (store.has(userId)) return { ok: false, reason: "in_flight" };
  store.add(userId);

  // Stale-scoped: only rows not already stored in `target`. This makes ONE
  // engine serve every caller — a currency SWITCH stales every row (all carry
  // the old currency) so all are reprocessed; the self-heal / backfill stale
  // only NULL / mismatched rows so new rows from ANY write path (portfolio
  // ops, stdio, reconcile, import) are picked up incrementally; steady state
  // is a no-op. It also means we never bump updated_at on already-correct rows.
  const stale = sql`(${schema.transactions.reportingCurrency} IS DISTINCT FROM ${target} OR ${schema.transactions.reportingAmount} IS NULL)`;

  try {
    // Distinct (currency, date) groups with at least one stale row — one rate
    // lookup + one UPDATE each.
    const groups = await db
      .selectDistinct({
        currency: schema.transactions.currency,
        date: schema.transactions.date,
      })
      .from(schema.transactions)
      .where(and(eq(schema.transactions.userId, userId), stale));

    await db
      .insert(schema.reportingRecomputeStatus)
      .values({
        userId,
        targetCurrency: target,
        total: groups.length,
        done: 0,
        startedAt: sql`NOW()`,
        finishedAt: null,
      })
      .onConflictDoUpdate({
        target: schema.reportingRecomputeStatus.userId,
        set: {
          targetCurrency: target,
          total: groups.length,
          done: 0,
          startedAt: sql`NOW()`,
          finishedAt: null,
        },
      });

    let done = 0;
    let updated = 0;
    let skipped = 0;
    for (const g of groups) {
      const cur = (g.currency ?? target).trim().toUpperCase();
      const fields = await computeReportingFields({
        userId,
        accountCurrency: cur,
        amount: 1,
        date: g.date,
        reportingCurrency: target,
      });
      if (fields) {
        const rate = fields.reportingRate;
        await db
          .update(schema.transactions)
          .set({
            reportingCurrency: target,
            reportingRate: rate,
            // round2 in SQL so each row is rounded individually (matches the
            // per-row write-path computation). amount is double precision →
            // cast to numeric for ROUND, back to double for the column.
            reportingAmount: sql`ROUND((${schema.transactions.amount} * ${rate})::numeric, 2)::double precision`,
            // Audit trio (issue #28): any transactions UPDATE bumps updated_at,
            // including this derived-field refresh (same precedent as the
            // settle-future-fx cron).
            updatedAt: sql`NOW()`,
          })
          .where(
            and(
              eq(schema.transactions.userId, userId),
              eq(schema.transactions.currency, cur),
              eq(schema.transactions.date, g.date),
              stale,
            ),
          );
        updated++;
      } else {
        skipped++;
      }
      done++;
      if (done % 25 === 0) {
        await db
          .update(schema.reportingRecomputeStatus)
          .set({ done })
          .where(eq(schema.reportingRecomputeStatus.userId, userId));
      }
    }

    await db
      .update(schema.reportingRecomputeStatus)
      .set({ done: groups.length, finishedAt: sql`NOW()` })
      .where(eq(schema.reportingRecomputeStatus.userId, userId));

    return { ok: true, pairs: groups.length, updated, skipped };
  } finally {
    store.delete(userId);
  }
}

/**
 * Fire-and-forget self-heal for flow-report loads. If the user has any row
 * whose stored reporting value is missing or in a stale currency, kick a
 * guarded background recompute into `displayCurrency`. Returns immediately —
 * the report renders correctly meanwhile via the on-the-fly fallback.
 */
export async function selfHealReportingAmounts(userId: string, displayCurrency: string): Promise<void> {
  // Fully defensive — this is fire-and-forget from report routes (`void
  // selfHealReportingAmounts(...)`), so it must NEVER reject. A failed staleness
  // probe (or a missing column pre-migration) just means "skip the backfill
  // this load"; the report already rendered via the on-the-fly fallback.
  try {
    const target = (displayCurrency ?? "").trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(target)) return;
    if (isReportingRecomputeInFlight(userId)) return;

    const stale = await db
      .select({ id: schema.transactions.id })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.userId, userId),
          sql`(${schema.transactions.reportingCurrency} IS DISTINCT FROM ${target} OR ${schema.transactions.reportingAmount} IS NULL)`,
        ),
      )
      .limit(1);

    if (stale.length === 0) return;

    // Detached — never block the report response.
    void recomputeReportingAmounts(userId, target).catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[reporting-amount] self-heal recompute failed for", userId, err);
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[reporting-amount] self-heal probe failed for", userId, err);
  }
}
