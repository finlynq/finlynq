/**
 * Unrealized profit & loss decomposed into:
 *   - valuationGL: market value moved against cost basis (asset price change)
 *   - fxGL:        account currency moved against display currency (FX change)
 *
 * Computed on the fly per the architecture decision in
 * plans/can-you-check-the-shiny-key.md — no snapshot storage.
 *
 * Period semantics: the period delta = snapshot_at_periodEnd minus
 * snapshot_at_periodStart, where each snapshot is "cumulative-since-
 * acquisition unrealized G/L evaluated at that date". Subtraction yields
 * how much UGL moved during the period — usable for monthly / quarterly /
 * annual P&L reports. Reports the periodEnd snapshot fields too so the
 * UI can show "current UGL" alongside "moved this period".
 *
 * Cost basis source: per-holding `avgCost = ABS(amount)/qty` aggregated
 * from buy-leg transactions inside `getHoldingsValueByAccount` (filtered
 * to date <= asOfDate). For pure-cash accounts cost basis = SUM(transactions
 * .amount) up to asOfDate.
 */

import { getAccountBalances } from "@/lib/queries";
import { getHoldingsValueByAccount, type AccountHoldingsValue } from "@/lib/holdings-value";
import { getDisplayCurrency, getRate } from "@/lib/fx-service";
import { decryptNamedRows } from "@/lib/crypto/encrypted-columns";
import { db, schema } from "@/db";
import { and, eq, lte, sql } from "drizzle-orm";

export type UnrealizedPnLSnapshot = {
  asOfDate: string;
  costBasisNative: number;
  marketValueNative: number;
  balanceNative: number;
  costBasis: number;        // display currency
  marketValue: number;      // display currency
  // Cumulative-since-acquisition UGL evaluated at asOfDate (in display ccy):
  valuationGLAtDate: number;
  fxGLAtDate: number;
  totalGLAtDate: number;
};

export type UnrealizedPnL = {
  accountId: number;
  accountName: string;
  accountCurrency: string;
  accountType: string;
  accountGroup: string;
  displayCurrency: string;
  periodStart: string;
  periodEnd: string;

  // Snapshots at start + end of the period.
  start: UnrealizedPnLSnapshot;
  end: UnrealizedPnLSnapshot;

  // Period delta = end.totalGLAtDate - start.totalGLAtDate, decomposed.
  // These are the headline numbers for "P&L this month / quarter / year".
  valuationGL: number;
  fxGL: number;
  totalGL: number;

  // Issue #236 (2026-05-10): when the period delta rounds to 0 but the
  // cumulative-since-acquisition UGL is non-zero (an "inactive holding"
  // whose cost basis ≠ market value AND the price didn't move in the
  // window), `valuationGL` falls through to the cumulative figure so the
  // open UGL surfaces in income-statement reports. `valuationGLBasis`
  // discloses which semantic produced the value:
  //   "period"     — strict end - start delta (default; non-zero deltas)
  //   "cumulative" — delta rounded to 0, fell through to end.valuationGLAtDate
  valuationGLBasis: "period" | "cumulative";

  hasHoldings: boolean;
  costBasisMissing: boolean;
};

function firstOfCurrentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function todayISO(): string {
  return new Date().toISOString().split("T")[0];
}

export type UnrealizedPnLOpts = {
  periodStart?: string;
  periodEnd?: string;
  displayCurrency?: string;
  dek?: Buffer | null;
  includeArchived?: boolean;
};

/** Sum of plaintext-amount transactions for an account up to asOfDate. */
async function getAccountCashFlowAtDate(
  userId: string,
  accountId: number,
  asOfDate: string,
): Promise<number> {
  const rows = await db
    .select({
      total: sql<number>`COALESCE(SUM(${schema.transactions.amount}), 0)::float8`,
    })
    .from(schema.transactions)
    .where(and(
      eq(schema.transactions.userId, userId),
      eq(schema.transactions.accountId, accountId),
      lte(schema.transactions.date, asOfDate),
    ));
  return Number(rows[0]?.total ?? 0);
}

async function buildSnapshot(
  userId: string,
  accountId: number,
  accountCurrency: string,
  displayCurrency: string,
  asOfDate: string,
  holdings: AccountHoldingsValue | undefined,
  fxAt: (from: string, to: string, date: string) => Promise<number>,
): Promise<UnrealizedPnLSnapshot> {
  const hasHoldings = !!holdings;
  const cashFlowSum = await getAccountCashFlowAtDate(userId, accountId, asOfDate);
  const balanceNative = hasHoldings ? holdings!.value : cashFlowSum;
  const marketValueNative = hasHoldings ? holdings!.value : cashFlowSum;
  const costBasisNative = hasHoldings ? holdings!.costBasis : cashFlowSum;
  const fx = await fxAt(accountCurrency, displayCurrency, asOfDate);
  const costBasis = costBasisNative * fx;
  const marketValue = marketValueNative * fx;
  // For "cumulative UGL evaluated AT asOfDate", FX G/L is the gap between
  // (cost basis × FX_atDate) and (cost basis × FX_at_costing_baseline).
  // We can't trivially recover the per-tx baseline FX, so we approximate:
  // valuationGLAtDate uses asOfDate's FX to translate; fxGLAtDate is left
  // as 0 here. The PERIOD fxGL surfaces below in the delta as
  // (balance × (FX_end - FX_start)) which is the real "FX moved during
  // the period" signal — exactly what the user asked for.
  const valuationGLAtDate = (marketValueNative - costBasisNative) * fx;
  return {
    asOfDate,
    costBasisNative,
    marketValueNative,
    balanceNative,
    costBasis,
    marketValue,
    valuationGLAtDate,
    fxGLAtDate: 0,
    totalGLAtDate: valuationGLAtDate,
  };
}

export async function computeAllAccountsUnrealizedPnL(
  userId: string,
  opts: UnrealizedPnLOpts = {},
): Promise<UnrealizedPnL[]> {
  const periodStart = opts.periodStart ?? firstOfCurrentMonth();
  const periodEnd = opts.periodEnd ?? todayISO();
  const displayCurrency = (opts.displayCurrency ?? await getDisplayCurrency(userId)).toUpperCase();
  const dek = opts.dek ?? null;
  const includeArchived = opts.includeArchived ?? false;

  const rawBalances = await getAccountBalances(userId, { includeArchived });
  const balances = decryptNamedRows(rawBalances, dek, {
    accountNameCt: "accountName",
    aliasCt: "alias",
  });

  // Two snapshots per account: one at periodStart, one at periodEnd.
  // Each snapshot computes its own qty / price / FX state internally.
  const [holdingsAtStart, holdingsAtEnd] = await Promise.all([
    getHoldingsValueByAccount(userId, dek, { asOfDate: periodStart }),
    getHoldingsValueByAccount(userId, dek, { asOfDate: periodEnd }),
  ]);

  const fxCache = new Map<string, number>();
  const fxAt = async (from: string, to: string, date: string): Promise<number> => {
    if (from === to) return 1;
    const key = `${from}->${to}@${date}`;
    if (fxCache.has(key)) return fxCache.get(key)!;
    const rate = await getRate(from, to, date, userId);
    fxCache.set(key, rate);
    return rate;
  };

  const out: UnrealizedPnL[] = [];
  for (const b of balances as any[]) {
    const accountId = Number(b.accountId);
    const accountCurrency = String(b.currency ?? displayCurrency).toUpperCase();
    const startHoldings = holdingsAtStart.get(accountId);
    const endHoldings = holdingsAtEnd.get(accountId);
    const hasHoldings = !!endHoldings || !!startHoldings;

    const start = await buildSnapshot(
      userId, accountId, accountCurrency, displayCurrency, periodStart, startHoldings, fxAt,
    );
    const end = await buildSnapshot(
      userId, accountId, accountCurrency, displayCurrency, periodEnd, endHoldings, fxAt,
    );

    // Period delta — what the user asked for: "this period - last period".
    // Valuation: cumulative UGL moved between snapshots.
    let valuationGL = end.valuationGLAtDate - start.valuationGLAtDate;
    let valuationGLBasis: "period" | "cumulative" = "period";
    // Issue #236 (2026-05-10): when the period delta rounds to 0 but the
    // cumulative-since-acquisition UGL is non-zero (an inactive holding
    // whose cost basis ≠ market value AND the price didn't move during the
    // window), surface the cumulative figure so income-statement consumers
    // can see open UGL. Without this fall-through, a holding like the audit
    // repro (cost 2920.27, mv 2918.04 with start==end) reported
    // `valuationGL: 0` even though there is a real -2.23 unrealized loss
    // sitting on the books. Conjunctive guard so legitimate quiescent
    // holdings (cumulative ~ 0 too, e.g. brand-new buy at par) keep
    // `valuationGL: 0` with basis="period".
    if (Math.abs(valuationGL) < 0.005 && Math.abs(end.valuationGLAtDate) >= 0.005) {
      valuationGL = end.valuationGLAtDate;
      valuationGLBasis = "cumulative";
    }
    // FX: holding the same balance over the period × the FX move. This
    // captures "how much CAD value of a USD account changed because USD/CAD
    // moved", independent of price changes.
    const fxRateStart = await fxAt(accountCurrency, displayCurrency, periodStart);
    const fxRateEnd = await fxAt(accountCurrency, displayCurrency, periodEnd);
    const fxGL = end.balanceNative * (fxRateEnd - fxRateStart);
    const totalGL = valuationGL + fxGL;

    const costBasisMissing = !!endHoldings
      && Math.abs(endHoldings.costBasis - endHoldings.value) < 0.005
      && endHoldings.value > 0;

    out.push({
      accountId,
      accountName: String(b.accountName ?? ""),
      accountCurrency,
      accountType: String(b.accountType ?? ""),
      accountGroup: String(b.accountGroup ?? ""),
      displayCurrency,
      periodStart,
      periodEnd,
      start,
      end,
      valuationGL,
      fxGL,
      totalGL,
      valuationGLBasis,
      hasHoldings,
      costBasisMissing,
    });
  }
  return out;
}

export async function computeAccountUnrealizedPnL(
  userId: string,
  accountId: number,
  opts: UnrealizedPnLOpts = {},
): Promise<UnrealizedPnL | null> {
  const all = await computeAllAccountsUnrealizedPnL(userId, opts);
  return all.find(a => a.accountId === accountId) ?? null;
}

export type UnrealizedPnLTotals = {
  displayCurrency: string;
  periodStart: string;
  periodEnd: string;
  costBasis: number;
  marketValue: number;
  valuationGL: number;
  fxGL: number;
  totalGL: number;
};

export function summarizeUnrealizedPnL(rows: UnrealizedPnL[]): UnrealizedPnLTotals {
  const first = rows[0];
  const out: UnrealizedPnLTotals = {
    displayCurrency: first?.displayCurrency ?? "CAD",
    periodStart: first?.periodStart ?? firstOfCurrentMonth(),
    periodEnd: first?.periodEnd ?? todayISO(),
    costBasis: 0,
    marketValue: 0,
    valuationGL: 0,
    fxGL: 0,
    totalGL: 0,
  };
  for (const r of rows) {
    out.costBasis += r.end.costBasis;
    out.marketValue += r.end.marketValue;
    out.valuationGL += r.valuationGL;
    out.fxGL += r.fxGL;
    out.totalGL += r.totalGL;
  }
  return out;
}
