/**
 * Daily snapshot builder — Phase 3 of plan/portfolio-lots-and-performance.md.
 *
 * For a given (user, date), persists one portfolio_snapshots row per
 * investment account PLUS one whole-portfolio aggregate (account_id
 * NULL). Reuses the Phase 1 / Phase 2 holdings-value aggregator to
 * stay aligned with the rest of the portfolio UI.
 *
 * Idempotent on the (user_id, snap_date, COALESCE(account_id, -1))
 * unique index — re-running for the same day is safe.
 *
 * Reporting-currency choice: snapshot lands in the user's CURRENT
 * reporting currency. Historical snapshots taken under a different
 * reporting ccy keep that ccy verbatim; the chart surfaces the
 * discontinuity via a tooltip.
 */

import { and, eq, gte, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { getHoldingsValueByAccount } from "@/lib/holdings-value";
import { resolveReportingCurrency } from "../../../../mcp-server/reporting-currency";
import { getRate } from "@/lib/fx-service";
import { computeNetContributions } from "../performance/contributions";

export interface BuildDailySnapshotInput {
  userId: string;
  date: string;       // YYYY-MM-DD
  dek: Buffer | null; // needed for decryptNamedRows inside getHoldingsValueByAccount
}

export interface BuildDailySnapshotResult {
  userId: string;
  date: string;
  perAccountRows: number;
  aggregateRow: boolean;
  gapsFilled: boolean;
}

export async function buildDailySnapshot(
  input: BuildDailySnapshotInput,
): Promise<BuildDailySnapshotResult> {
  const { userId, date, dek } = input;
  const reportingCurrency = await resolveReportingCurrency(db, userId, undefined);

  // Per-account market value + cost basis (in account currency).
  const perAccount = await getHoldingsValueByAccount(userId, dek, {
    asOfDate: date,
  });

  // Compute net contributions for this day across all the user's investment
  // accounts. We bucket per-account by counting only the leg on each.
  // For day-of granularity we treat all of date's flows as "net for day".
  const todaysFlows = await computeNetContributions({
    userId,
    accountId: null,
    fromDate: date,
    toDate: date,
  });
  const perAccountContribution = new Map<number, number>();
  // Map cash flows back to account_id via the source transactions.
  // computeNetContributions doesn't return accountId today (sign-only),
  // so re-query for the same window to attribute. Cheap, single-day.
  const sameDayLegs = await db
    .select({
      accountId: schema.transactions.accountId,
      enteredAmount: schema.transactions.enteredAmount,
      amount: schema.transactions.amount,
      linkId: schema.transactions.linkId,
      tradeLinkId: schema.transactions.tradeLinkId,
      quantity: schema.transactions.quantity,
      kind: schema.transactions.kind,
    })
    .from(schema.transactions)
    .where(
      and(
        eq(schema.transactions.userId, userId),
        eq(schema.transactions.date, date),
      ),
    );
  for (const leg of sameDayLegs) {
    if (!leg.linkId || leg.accountId == null) continue;
    // Issue #128 (Phase 2 update, 2026-05-26): buy/sell paired cash legs
    // aren't contributions — they're internal swaps within the account.
    // Use `kind` discriminator for Phase 2+ rows; legacy `(amount=0 OR
    // quantity=0)` predicate covers pre-migration rows.
    if (leg.kind === "buy_cash_leg" || leg.kind === "sell_cash_leg") continue;
    if (leg.tradeLinkId != null && (leg.amount === 0 || leg.quantity === 0)) continue;
    const value = Number(leg.enteredAmount ?? leg.amount ?? 0);
    if (value === 0) continue;
    // contribution INTO an account = positive on the receiving leg.
    // Mirror the snapshot's positive convention (the table stores
    // net_contribution as POSITIVE for inflows).
    perAccountContribution.set(
      leg.accountId,
      (perAccountContribution.get(leg.accountId) ?? 0) + value,
    );
  }
  void todaysFlows; // computed for parity / future MWRR pre-cache use

  // ─── FX cache for account-ccy → reporting-ccy ───
  const fxCache = new Map<string, number>();
  let gapsFilled = false;
  const fx = async (from: string, to: string): Promise<number> => {
    if (from === to) return 1;
    const key = `${from}>${to}`;
    if (fxCache.has(key)) return fxCache.get(key)!;
    try {
      const rate = await getRate(from, to, date, userId);
      fxCache.set(key, rate || 1);
      if (!rate) gapsFilled = true;
      return rate || 1;
    } catch {
      fxCache.set(key, 1);
      gapsFilled = true;
      return 1;
    }
  };

  // ─── Per-account rows ───
  let perAccountRows = 0;
  let totalMv = 0;
  let totalCb = 0;
  let totalContrib = 0;

  for (const [accountId, v] of perAccount) {
    const fxRate = await fx(v.currency, reportingCurrency);
    const mv = v.value * fxRate;
    const cb = v.costBasis * fxRate;
    const contribution = (perAccountContribution.get(accountId) ?? 0) * fxRate;
    await db
      .insert(schema.portfolioSnapshots)
      .values({
        userId,
        snapDate: date,
        accountId,
        marketValue: mv,
        costBasis: cb,
        netContribution: contribution,
        currency: reportingCurrency,
        gapsFilled,
        source: "cron",
      })
      .onConflictDoUpdate({
        target: [
          schema.portfolioSnapshots.userId,
          schema.portfolioSnapshots.snapDate,
          schema.portfolioSnapshots.accountId,
        ],
        set: {
          marketValue: mv,
          costBasis: cb,
          netContribution: contribution,
          currency: reportingCurrency,
          gapsFilled,
        },
      });
    perAccountRows++;
    totalMv += mv;
    totalCb += cb;
    totalContrib += contribution;
  }

  // ─── Whole-portfolio aggregate (accountId NULL) ───
  // The unique index uses COALESCE(account_id, -1) to dedupe the
  // aggregate row. Drizzle's onConflictDoUpdate doesn't accept
  // COALESCE expressions natively, so write via raw SQL.
  await db.execute(sql`
    INSERT INTO portfolio_snapshots (
      user_id, snap_date, account_id, market_value, cost_basis,
      net_contribution, currency, gaps_filled, source
    ) VALUES (
      ${userId}, ${date}, NULL, ${totalMv}, ${totalCb},
      ${totalContrib}, ${reportingCurrency}, ${gapsFilled}, ${'cron'}
    )
    ON CONFLICT (user_id, snap_date, COALESCE(account_id, -1))
    DO UPDATE SET
      market_value = EXCLUDED.market_value,
      cost_basis = EXCLUDED.cost_basis,
      net_contribution = EXCLUDED.net_contribution,
      currency = EXCLUDED.currency,
      gaps_filled = EXCLUDED.gaps_filled
  `);

  // Suppress unused-import warning — gte is referenced for future windowed builds.
  void gte;

  return {
    userId,
    date,
    perAccountRows,
    aggregateRow: true,
    gapsFilled,
  };
}
