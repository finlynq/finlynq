/**
 * Read-path helpers for the lot-tracked metrics engine.
 *
 * The three portfolio aggregators (REST /api/portfolio/overview,
 * src/lib/holdings-value.ts, MCP HTTP register-tools-pg.ts::aggregateHoldings)
 * branch on `portfolio_lots_status.enabled` to pick the lot-derived metrics
 * path vs the legacy avg-cost math. This file is the shared entry point:
 *
 *   - isLotsEnabledForUser(userId)   — quick flag check; cached in-process
 *   - loadMetricsForUser(userId, dek, asOfDate, reportingCurrency)
 *                                     — full lot read + dividends agg +
 *                                       prices map + FX resolver assembly +
 *                                       computeHoldingMetricsFromLots
 *
 * The aggregators stay in control of their existing UI shape (REST returns
 * a flat list, holdings-value returns per-account totals, MCP HTTP returns
 * a richer tool-specific envelope). They consume the PerHoldingMetrics
 * array returned here and project to their own shape.
 */

import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { getLatestFxRate, getRate } from "@/lib/fx-service";
import { resolveDividendsCategoryId } from "@/lib/dividends-category";
import { computeHoldingMetricsFromLots } from "../metrics";
import type {
  FxConverter,
  DividendsMap,
  PriceMap,
} from "../metrics";
import type {
  HoldingLot,
  HoldingLotClosure,
  PerHoldingMetrics,
} from "./types";
import { todayISO } from "@/lib/utils/date";

// ─── feature flag ─────────────────────────────────────────────────────────

const flagCache = new Map<string, { value: boolean; until: number }>();
const FLAG_TTL_MS = 30_000; // 30s — short enough that a manual flip propagates within a request burst.

/**
 * Cached-with-TTL check of `portfolio_lots_status.enabled` for a user. The
 * caller of an aggregator may invoke this multiple times per request; the
 * cache amortizes the lookup.
 */
export async function isLotsEnabledForUser(userId: string): Promise<boolean> {
  const cached = flagCache.get(userId);
  if (cached && cached.until > Date.now()) return cached.value;
  const rows = await db
    .select({ enabled: schema.portfolioLotsStatus.enabled })
    .from(schema.portfolioLotsStatus)
    .where(eq(schema.portfolioLotsStatus.userId, userId))
    .limit(1);
  const value = rows[0]?.enabled ?? false;
  flagCache.set(userId, { value, until: Date.now() + FLAG_TTL_MS });
  return value;
}

/** Bust the cache for a user — admin flag-flip helper. */
export function clearLotsEnabledCache(userId?: string): void {
  if (userId) flagCache.delete(userId);
  else flagCache.clear();
}

// ─── full metrics load ────────────────────────────────────────────────────

export interface LoadMetricsForUserOpts {
  userId: string;
  dek: Buffer | null;
  asOfDate: string; // YYYY-MM-DD
  /**
   * Caller-supplied price lookup. The aggregator already fetched these
   * for its own UI; pass through to avoid duplicating Yahoo / CoinGecko
   * calls. Keyed by holdingId; price + currency.
   */
  prices: PriceMap;
  /**
   * FINLYNQ-279: when set, each open lot's cost basis is ALSO valued in this
   * currency at the historical rate on the lot's open date, returned as
   * `PerHoldingMetrics.costBasisReporting`. The overview passes the user's
   * display currency so the FX-on-cost gain is captured. Omit → costBasisReporting
   * equals the native costBasis (byte-identical no-op).
   */
  reportingCurrency?: string;
}

/**
 * Loads every lot + closure for the user, aggregates dividends from
 * `transactions` (issue #84 category-id classification), and runs
 * computeHoldingMetricsFromLots. Returns one PerHoldingMetrics row per
 * (holding, account) pair.
 *
 * NOT gated by `isLotsEnabledForUser` — callers do the flag check
 * themselves and skip this function on the legacy path.
 */
export async function loadMetricsForUser(
  opts: LoadMetricsForUserOpts,
): Promise<PerHoldingMetrics[]> {
  const { userId, dek, asOfDate, prices, reportingCurrency } = opts;
  const isToday = asOfDate >= todayISO();

  // ─── Lots ─────────────────────────────────────────────────────────────
  const lotRows = await db
    .select()
    .from(schema.holdingLots)
    .where(eq(schema.holdingLots.userId, userId));
  const lots: HoldingLot[] = lotRows.map((r) => ({
    id: r.id,
    userId: r.userId,
    holdingId: r.holdingId,
    accountId: r.accountId,
    openTxId: r.openTxId,
    openDate: r.openDate,
    qtyOriginal: Number(r.qtyOriginal),
    qtyRemaining: Number(r.qtyRemaining),
    costPerShare: Number(r.costPerShare),
    side: (((r as unknown as { side?: string | null }).side ?? "long") as HoldingLot["side"]),
    currency: r.currency,
    fxToUsdAtOpen: r.fxToUsdAtOpen,
    origin: r.origin as HoldingLot["origin"],
    parentLotId: r.parentLotId,
    status: r.status as HoldingLot["status"],
    source: r.source as HoldingLot["source"],
  }));

  // ─── Closures ────────────────────────────────────────────────────────
  const closureRows = await db
    .select()
    .from(schema.holdingLotClosures)
    .where(eq(schema.holdingLotClosures.userId, userId));
  const closures: HoldingLotClosure[] = closureRows.map((r) => ({
    id: r.id,
    userId: r.userId,
    lotId: r.lotId,
    closeTxId: r.closeTxId,
    closeDate: r.closeDate,
    qtyClosed: Number(r.qtyClosed),
    proceedsPerShare: Number(r.proceedsPerShare),
    costPerShare: Number(r.costPerShare),
    realizedGain: Number(r.realizedGain),
    currency: r.currency,
    daysHeld: Number(r.daysHeld),
    closeKind: r.closeKind as HoldingLotClosure["closeKind"],
    source: r.source as HoldingLotClosure["source"],
  }));

  // ─── Holding currencies ───────────────────────────────────────────────
  const holdingRows = await db
    .select({
      id: schema.portfolioHoldings.id,
      currency: schema.portfolioHoldings.currency,
    })
    .from(schema.portfolioHoldings)
    .where(eq(schema.portfolioHoldings.userId, userId));
  const holdingCurrencies = new Map<number, string>();
  for (const h of holdingRows) holdingCurrencies.set(h.id, h.currency);

  // ─── Dividends — issue #84 category-id classification ────────────────
  const yearStart = `${asOfDate.slice(0, 4)}-01-01`;
  const dividends: DividendsMap = new Map();
  const dividendsCategoryId = await resolveDividendsCategoryId(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db as any,
    userId,
    dek,
  );
  if (dividendsCategoryId != null) {
    const divRows = await db
      .select({
        // FINLYNQ-173: attribute the dividend to the PAYING SECURITY
        // (related_holding_id) not the cash sleeve it landed on
        // (portfolio_holding_id). Fall back to the cash sleeve only when no
        // related holding was stamped (legacy rows / genuine cash interest).
        holdingId: sql<number | null>`COALESCE(${schema.transactions.relatedHoldingId}, ${schema.transactions.portfolioHoldingId})`,
        accountId: schema.transactions.accountId,
        amount: schema.transactions.amount,
        enteredAmount: schema.transactions.enteredAmount,
        enteredCurrency: schema.transactions.enteredCurrency,
        currency: schema.transactions.currency,
        date: schema.transactions.date,
      })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.userId, userId),
          eq(schema.transactions.categoryId, dividendsCategoryId),
          isNotNull(schema.transactions.portfolioHoldingId),
          isNotNull(schema.transactions.accountId),
        ),
      );
    for (const r of divRows) {
      if (r.holdingId == null || r.accountId == null) continue;
      if (r.date > asOfDate) continue;
      // FINLYNQ-173: `holdingId` is now the attribution target (paying
      // security via related_holding_id, else the cash sleeve). The dividend
      // AMOUNT, however, is denominated in the currency it was PAID in (the
      // cash sleeve's currency, captured on the row's entered_currency /
      // currency) — NOT the security's currency. Tag the cell with the paid
      // currency so the metrics layer FX-converts it correctly to the
      // attribution holding's currency (e.g. a CAD dividend credited to a
      // USD ETF converts CAD→USD, not USD→USD).
      const key = `${r.holdingId}:${r.accountId}`;
      const paidCurrency =
        (r.enteredCurrency ?? r.currency ?? holdingCurrencies.get(r.holdingId) ?? "USD") as string;
      const cell = dividends.get(key) ?? {
        ytd: 0,
        allTime: 0,
        currency: paidCurrency,
      };
      const amount = Number(r.enteredAmount ?? r.amount ?? 0);
      cell.allTime += amount;
      if (r.date >= yearStart) cell.ytd += amount;
      dividends.set(key, cell);
    }
  }

  // ─── FX converter — async ladder wrapped in a sync cache ─────────────
  // The metrics layer expects a sync `fx` callback; we pre-resolve every
  // distinct (from, to) pair across lots, closures, dividends, and prices.
  const pairs = new Set<string>();
  const addPair = (from: string, to: string) => {
    if (!from || !to || from === to) return;
    pairs.add(`${from}>${to}`);
  };
  for (const l of lots) {
    const target = holdingCurrencies.get(l.holdingId) ?? l.currency;
    addPair(l.currency, target);
  }
  for (const c of closures) {
    const lot = lots.find((l) => l.id === c.lotId);
    if (lot) {
      const target = holdingCurrencies.get(lot.holdingId) ?? lot.currency;
      addPair(c.currency, target);
    }
  }
  for (const [key, row] of dividends) {
    const [hStr] = key.split(":");
    const hId = Number(hStr);
    const target = holdingCurrencies.get(hId) ?? row.currency;
    addPair(row.currency, target);
  }
  for (const [hId, p] of prices) {
    const target = holdingCurrencies.get(hId) ?? p.currency;
    addPair(p.currency, target);
  }
  const fxMap = new Map<string, number>();
  for (const p of pairs) {
    const [from, to] = p.split(">");
    try {
      const rate = isToday
        ? await getLatestFxRate(from, to, userId)
        : await getRate(from, to, asOfDate, userId);
      fxMap.set(p, rate || 1);
    } catch {
      fxMap.set(p, 1);
    }
  }
  const fx: FxConverter = (amount, from, to) => {
    if (from === to) return amount;
    const rate = fxMap.get(`${from}>${to}`);
    if (rate != null) return amount * rate;
    // Defensive fallback — emit 1.0 and log.

    console.warn(
      `[portfolio.lots.read] fx ${from}->${to} missing in pre-resolve; returning 1.0`,
    );
    return amount;
  };

  // ─── FINLYNQ-279: historical reporting-currency rates ─────────────────
  // One rate per (lotCcy → reportingCcy, openDate) across the open lots, so
  // the metrics layer can value each open lot's cost basis at the rate on its
  // OWN open date (FX-on-cost). Only foreign-currency lots need a lookup;
  // same-currency lots resolve to 1 without a call. Rates hit price_cache /
  // fx_rates (warm on prod) and are deduped so a busy account is a handful of
  // lookups, not one per lot.
  const histFxMap = new Map<string, number>();
  let fxAtDate:
    | ((amount: number, from: string, to: string, date: string) => number)
    | undefined;
  if (reportingCurrency) {
    const histPairs = new Set<string>();
    for (const l of lots) {
      if (l.status !== "open" || l.qtyRemaining <= 0) continue;
      if (l.openDate > asOfDate) continue;
      if (!l.currency || l.currency === reportingCurrency) continue;
      histPairs.add(`${l.currency}>${reportingCurrency}>${l.openDate}`);
    }
    for (const key of histPairs) {
      const [from, to, date] = key.split(">");
      try {
        histFxMap.set(key, (await getRate(from, to, date, userId)) || 1);
      } catch {
        histFxMap.set(key, 1);
      }
    }
    fxAtDate = (amount, from, to, date) => {
      if (from === to) return amount;
      const r = histFxMap.get(`${from}>${to}>${date}`);
      return r != null ? amount * r : amount;
    };
  }

  return computeHoldingMetricsFromLots({
    lots,
    closures,
    dividends,
    prices,
    fx,
    asOfDate,
    holdingCurrencies,
    reportingCurrency,
    fxAtDate,
  });
}
