/**
 * Portfolio returns over a period: the daily value series from
 * `portfolio_snapshots`, plus TWRR and XIRR with NEW MONEY stripped out.
 * SERVER ONLY (reads the DB).
 *
 * The single implementation behind REST `/api/portfolio/performance` (the
 * Portfolio page's Performance chart) and MCP `get_portfolio_returns`, which
 * each carried their own copy until 2026-10-14.
 *
 * New money is computed HERE, from the transactions, at read time — not read
 * from the stored `portfolio_snapshots.net_contribution`, which only ever
 * counted transfer legs and is fixed per row at build time. Reading it live
 * means the corrected rule (performance/external-flows.ts) applies to every
 * past period without rebuilding history, and TWRR and XIRR use the very same
 * flows. Each flow is valued in the snapshots' reporting currency: the stored
 * `reporting_amount` when it is in that currency, else converted at the
 * transaction date's rate.
 */

import { and, eq, gt, gte, inArray, isNull, lte } from "drizzle-orm";
import { db, schema } from "@/db";
import { getRate } from "@/lib/fx-service";
import { findInvestmentIncomeCategoryIds } from "@/lib/investment-income-category";
import { computeTwrr, annualizeReturn } from "./twrr";
import { computeMwrr, type CashFlow } from "./mwrr";
import { newMoneyAmount } from "./external-flows";

export type ReturnsPeriod = "1m" | "3m" | "6m" | "ytd" | "1y" | "all";

const PERIOD_DAYS: Record<ReturnsPeriod, number | null> = {
  "1m": 30,
  "3m": 90,
  "6m": 180,
  ytd: -1, // sentinel: from Jan 1 of asOfDate's year
  "1y": 365,
  all: null,
};

export function periodStart(period: ReturnsPeriod, asOfDate: string): string {
  if (period === "ytd") return `${asOfDate.slice(0, 4)}-01-01`;
  const days = PERIOD_DAYS[period];
  if (days == null) return "1900-01-01";
  const d = new Date(`${asOfDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export interface ReturnsPoint {
  date: string;
  marketValue: number;
  costBasis: number;
  /** New money that day (+ in, − out), in the reporting currency. */
  contribution: number;
  gapsFilled: boolean;
}

export interface PortfolioReturns {
  period: ReturnsPeriod;
  accountId: number | null;
  from: string;
  to: string;
  currency: string;
  series: ReturnsPoint[];
  twrr: { period: number; annualized: number; hadContributions: boolean };
  mwrr: { irr: number; converged: boolean };
  /** Net new money over the period (+ in, − out). */
  netNewMoney: number;
  /** False when the user's key was unavailable, so reinvested income in
   *  non-investment categories could not be told apart and was left as return. */
  incomeCategoriesResolved: boolean;
  gapsFilledDays: number;
}

/**
 * New money per day after `afterDate` up to `throughDate`, on the given
 * accounts, in `currency`. Exported for tests.
 */
export async function loadNewMoneyByDate(input: {
  userId: string;
  dek: Buffer | null;
  accountIds: number[];
  afterDate: string;
  throughDate: string;
  currency: string;
}): Promise<{ byDate: Map<string, number>; incomeCategoriesResolved: boolean }> {
  const { userId, dek, accountIds, afterDate, throughDate, currency } = input;
  const byDate = new Map<string, number>();
  const incomeIds = await findInvestmentIncomeCategoryIds(db, userId, dek);
  if (accountIds.length === 0) return { byDate, incomeCategoriesResolved: incomeIds != null };

  const rows = await db
    .select({
      date: schema.transactions.date,
      kind: schema.transactions.kind,
      linkId: schema.transactions.linkId,
      tradeLinkId: schema.transactions.tradeLinkId,
      amount: schema.transactions.amount,
      quantity: schema.transactions.quantity,
      currency: schema.transactions.currency,
      reportingCurrency: schema.transactions.reportingCurrency,
      reportingAmount: schema.transactions.reportingAmount,
      categoryId: schema.transactions.categoryId,
      categoryType: schema.categories.type,
      holdingId: schema.transactions.portfolioHoldingId,
      holdingIsCash: schema.portfolioHoldings.isCash,
    })
    .from(schema.transactions)
    .leftJoin(schema.categories, eq(schema.categories.id, schema.transactions.categoryId))
    .leftJoin(schema.portfolioHoldings, eq(schema.portfolioHoldings.id, schema.transactions.portfolioHoldingId))
    .where(
      and(
        eq(schema.transactions.userId, userId),
        inArray(schema.transactions.accountId, accountIds),
        gt(schema.transactions.date, afterDate),
        lte(schema.transactions.date, throughDate),
      ),
    );

  const rateCache = new Map<string, number>();
  const target = currency.toUpperCase();
  for (const r of rows) {
    const amount = Number(r.amount ?? 0);
    const flow = {
      kind: r.kind ?? null,
      linkId: r.linkId ?? null,
      tradeLinkId: r.tradeLinkId ?? null,
      amount,
      quantity: r.quantity == null ? null : Number(r.quantity),
      categoryId: r.categoryId ?? null,
      categoryType: r.categoryType ?? null,
      onSecurity: r.holdingId != null && !r.holdingIsCash,
    };
    const inOwnCurrency = newMoneyAmount(flow, incomeIds);
    if (inOwnCurrency == null) continue;
    let value: number;
    if ((r.reportingCurrency ?? "").toUpperCase() === target && r.reportingAmount != null) {
      // Same magnitude as `amount`, at the transaction date's rate; take the
      // direction from the rule (a single-row buy's amount is negative).
      value = Math.sign(inOwnCurrency) * Math.abs(Number(r.reportingAmount));
    } else {
      const from = (r.currency ?? target).toUpperCase();
      const key = `${from}|${r.date}`;
      let rate = rateCache.get(key);
      if (rate == null) {
        rate = from === target ? 1 : (await getRate(from, target, r.date, userId)) || 1;
        rateCache.set(key, rate);
      }
      value = inOwnCurrency * rate;
    }
    byDate.set(r.date, (byDate.get(r.date) ?? 0) + value);
  }
  return { byDate, incomeCategoriesResolved: incomeIds != null };
}

export async function computePortfolioReturns(input: {
  userId: string;
  dek: Buffer | null;
  period: ReturnsPeriod;
  accountId: number | null;
  asOfDate?: string;
}): Promise<PortfolioReturns> {
  const { userId, dek, period, accountId } = input;
  const asOfDate = input.asOfDate ?? new Date().toISOString().slice(0, 10);
  const from = periodStart(period, asOfDate);

  const preds = [
    eq(schema.portfolioSnapshots.userId, userId),
    gte(schema.portfolioSnapshots.snapDate, from),
    lte(schema.portfolioSnapshots.snapDate, asOfDate),
    accountId != null
      ? eq(schema.portfolioSnapshots.accountId, accountId)
      : isNull(schema.portfolioSnapshots.accountId), // whole-portfolio aggregate row
  ];
  const rows = await db
    .select({
      date: schema.portfolioSnapshots.snapDate,
      marketValue: schema.portfolioSnapshots.marketValue,
      costBasis: schema.portfolioSnapshots.costBasis,
      currency: schema.portfolioSnapshots.currency,
      gapsFilled: schema.portfolioSnapshots.gapsFilled,
    })
    .from(schema.portfolioSnapshots)
    .where(and(...preds))
    .orderBy(schema.portfolioSnapshots.snapDate);

  const currency = rows[0]?.currency ?? "USD";
  const series: ReturnsPoint[] = rows.map((r) => ({
    date: r.date,
    marketValue: Number(r.marketValue),
    costBasis: Number(r.costBasis),
    contribution: 0,
    gapsFilled: r.gapsFilled,
  }));

  let netNewMoney = 0;
  let incomeCategoriesResolved = dek != null;
  const flows: CashFlow[] = [];
  if (series.length > 0) {
    // The aggregate covers the investment accounts (the snapshot builder
    // values every account that holds positions).
    const accountIds =
      accountId != null
        ? [accountId]
        : (
            await db
              .select({ id: schema.accounts.id })
              .from(schema.accounts)
              .where(and(eq(schema.accounts.userId, userId), eq(schema.accounts.isInvestment, true)))
          ).map((a) => a.id);
    // Flows on or before the first point are already inside its value.
    const loaded = await loadNewMoneyByDate({
      userId,
      dek,
      accountIds,
      afterDate: series[0].date,
      throughDate: asOfDate,
      currency,
    });
    incomeCategoriesResolved = loaded.incomeCategoriesResolved;
    // Attach each day's flow to the first point on or after it (a day with
    // no snapshot rolls into the next one).
    let i = 0;
    for (const [date, value] of [...loaded.byDate.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      while (i < series.length && series[i].date < date) i++;
      if (i >= series.length) break;
      series[i].contribution += value;
      netNewMoney += value;
      flows.push({ date: series[i].date, amount: -value }); // XIRR: money in is negative
    }
  }

  const twrr = computeTwrr(series.map((p) => ({ date: p.date, marketValue: p.marketValue, contribution: p.contribution })));

  let mwrr = { irr: 0, converged: false };
  if (series.length > 0) {
    const startMv = series[0].marketValue;
    const cashFlows: CashFlow[] = startMv > 0 ? [{ date: series[0].date, amount: -startMv }, ...flows] : flows;
    const result = computeMwrr(cashFlows, series[series.length - 1].marketValue, series[series.length - 1].date);
    mwrr = { irr: result.irr, converged: result.converged };
  }

  const periodDays =
    series.length >= 2
      ? Math.max(1, Math.round((Date.parse(series[series.length - 1].date) - Date.parse(series[0].date)) / 86400000))
      : 0;

  return {
    period,
    accountId,
    from,
    to: asOfDate,
    currency,
    series,
    twrr: {
      period: twrr.periodReturn,
      annualized: annualizeReturn(twrr.periodReturn, periodDays),
      hadContributions: twrr.hadContributions,
    },
    mwrr,
    netNewMoney,
    incomeCategoriesResolved,
    gapsFilledDays: series.filter((p) => p.gapsFilled).length,
  };
}
