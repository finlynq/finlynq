/**
 * Net Worth & Account Balance Over Time — pure core.
 *
 * Builds a daily series merging two data sources that the rest of the app
 * already trusts, BOTH now read from the stored daily `portfolio_snapshots`
 * table with identical per-account carry-forward machinery:
 *   - CASH / LIABILITY accounts: per-account balance read from `source='cash'`
 *     snapshots, stored in the reporting currency at EACH DAY'S historical FX
 *     rate (built DEK-free; see cash-builder.ts). TODAY is substituted by the
 *     live account balance so the latest point matches the dashboard hero.
 *   - INVESTMENT accounts: market value read from the `source!='cash'`
 *     snapshots (nearest at-or-before each grid day), with TODAY substituted by
 *     the live holdings aggregator — same hero-match guarantee.
 *
 * Why not the legacy `getNetWorthOverTime()` (pure SUM of tx amounts)? For an
 * investment account the buy/sell legs net to ~0 under the two-leg convention,
 * so its real value is `holdings.value` (market value), not its tx sum.
 *
 * Pure / unit-testable: no DB, no HTTP, no `Date.now()`. The caller supplies
 * `today` and pre-fetched rows. `convertWithRateMap` is a passthrough when a
 * snapshot's stored currency already equals the display currency; it re-bases
 * at the CURRENT rate only when the user switched display currency after the
 * snapshot was stored (the same documented value-chart discontinuity the
 * investment side has). The live-today override + that display-switch re-base
 * are the only current-rate uses left under the `reporting` basis, so it keeps
 * `fxApproximation: true`.
 *
 * FINLYNQ-303 — the series can also be built on the `native` basis: each value
 * read straight from the stored native columns (the account's OWN currency)
 * with NO conversion at all, which sidesteps both of those approximations. It
 * is valid ONLY for a single account (a mixed-currency total has no native
 * basis) and only when every in-scope row carries a native value; otherwise the
 * result downgrades to `reporting` and says so via `basisUsed`.
 */

import { convertWithRateMap } from "@/lib/fx-service";

export type NetWorthPeriod = "6m" | "1y" | "all";

/**
 * Which currency basis a series is expressed in (FINLYNQ-303).
 *
 * - `reporting` — the historical default: every account translated into the
 *   user's display currency. The ONLY basis valid for a multi-account series,
 *   since that is the only way a mixed-currency total means anything.
 * - `native` — each account in its OWN currency, read straight from the stored
 *   native columns with NO conversion. Only meaningful for a SINGLE account;
 *   the caller must reject it when `accountId` is absent (FINLYNQ-123: never
 *   sum mixed currencies under one label).
 */
export type CurrencyBasis = "reporting" | "native";

/**
 * One per-account stored snapshot row. `marketValue` is in `currency` (the
 * reporting currency at snap time). `nativeMarketValue`/`nativeCurrency` carry
 * the SAME balance in the account's own currency (FINLYNQ-303) — null on the
 * whole-portfolio aggregate row and on rows written before the dual-basis
 * rebuild. Used for BOTH the cash and investment passes — they're structurally
 * identical (per-account carry-forward).
 */
export interface AccountSnapshot {
  accountId: number;
  snapDate: string; // YYYY-MM-DD
  marketValue: number;
  currency: string;
  nativeMarketValue?: number | null;
  nativeCurrency?: string | null;
}

/** @deprecated alias kept for callers/tests — same shape as AccountSnapshot. */
export type InvestmentSnapshot = AccountSnapshot;

/** Live (today's) value per account, in account currency. */
export interface LiveAccountValue {
  value: number;
  currency: string;
}

/** @deprecated alias kept for the route import — same shape as LiveAccountValue. */
export type LiveInvestmentValue = LiveAccountValue;

export interface BuildNetWorthHistoryInput {
  period: NetWorthPeriod;
  displayCurrency: string;
  /**
   * Currency basis to express the series in (FINLYNQ-303). Defaults to
   * `reporting` — the historical behaviour. `native` is honoured only when
   * EVERY in-scope snapshot row carries a native value; otherwise the result
   * silently downgrades to `reporting` and reports that via `basisUsed`. The
   * all-or-nothing rule is deliberate: a per-row fallback would draw one line
   * whose points are partly in the account currency and partly in the display
   * currency, which is precisely the mixed-currency-under-one-label failure
   * FINLYNQ-123 forbids.
   */
  basis?: CurrencyBasis;
  /** Rate map keyed by source currency → factor to displayCurrency (getRateMap). */
  rateMap: Map<string, number>;
  /**
   * Per-account CASH snapshots (source='cash') over the requested range. Stored
   * in the reporting currency at each day's historical rate. Any order.
   */
  cashSnapshots: AccountSnapshot[];
  /**
   * Today's live cash balance per non-investment account (account currency).
   * Overrides the snapshot value on the final grid day so the latest point
   * matches the dashboard hero exactly. Restrict to non-archived non-investment
   * accounts in the caller.
   */
  liveCashByAccount?: Map<number, LiveAccountValue>;
  /** Per-account investment snapshots over the requested range (any order). */
  snapshots: AccountSnapshot[];
  /**
   * Today's live holdings value per investment account (account currency).
   * Used to override the snapshot value on the final grid day so the latest
   * point matches the dashboard hero exactly. Restrict to non-archived
   * investment accounts in the caller to mirror the hero's account set.
   */
  liveInvestmentByAccount?: Map<number, LiveAccountValue>;
  /** Today, YYYY-MM-DD (UTC). The grid never extends past this. */
  today: string;
}

/**
 * One member's contribution on a grid day, keyed by account. Names are NOT
 * resolved here (the pure core has no DEK) — the route maps accountId → a
 * decrypted, safeName-fallback label before serializing. FINLYNQ-128.
 */
export interface NetWorthBreakdownEntry {
  accountId: number;
  value: number;
}

export interface NetWorthPoint {
  date: string; // YYYY-MM-DD
  value: number;
  /**
   * Per-account contributions to `value` on this day (cash + investment passes
   * merged). Drives the tooltip top-10 breakdown (FINLYNQ-128) and the stacked
   * view (FINLYNQ-129). Same currency basis as `value`.
   */
  breakdown: NetWorthBreakdownEntry[];
}

export interface BuildNetWorthHistoryResult {
  series: NetWorthPoint[];
  hasInvestmentData: boolean;
  /**
   * The basis the series is ACTUALLY in. Equals the requested `basis` unless a
   * native request had to downgrade for lack of native columns — callers must
   * label the chart from this, never from what they asked for.
   */
  basisUsed: CurrencyBasis;
  /**
   * The currency `series[].value` is denominated in. Under `reporting` this is
   * the display currency; under `native` it is the account's own currency.
   */
  seriesCurrency: string;
  /**
   * True when any value went through a current-rate conversion. Under
   * `reporting` this is always true (the live-today override and a post-storage
   * display-currency switch both re-base at the current rate). Under `native`
   * it is true only when investments are involved: a cash series is genuinely
   * FX-free (pure cumulative SUM in the account currency), whereas an
   * investment's holdings were already converted holding→account currency at
   * build time — native removes only the account→reporting leg.
   */
  fxApproximation: boolean;
}

const PERIOD_DAYS: Record<Exclude<NetWorthPeriod, "all">, number> = {
  "6m": 180,
  "1y": 365,
};

/** Add `days` (can be negative) to an ISO date, dialect-agnostic via UTC. */
function addDaysISO(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** ascending min of two optional ISO dates */
function minDate(a: string | null, b: string | null): string | null {
  if (a == null) return b;
  if (b == null) return a;
  return a < b ? a : b;
}

/** Earliest snapDate across a snapshot set (null if empty). */
function earliestSnapDate(rows: AccountSnapshot[]): string | null {
  return rows.reduce<string | null>(
    (m, s) => (m == null || s.snapDate < m ? s.snapDate : m),
    null,
  );
}

/** Per-account walking pointer + last carried value (in displayCurrency). */
interface SnapState {
  ptr: number;
  lastValue: number;
  rows: AccountSnapshot[];
}

/** Pre-group + sort snapshots per account into walking state. */
function buildSnapStates(rows: AccountSnapshot[]): Map<number, SnapState> {
  const byAccount = new Map<number, AccountSnapshot[]>();
  for (const s of rows) {
    const arr = byAccount.get(s.accountId) ?? [];
    arr.push(s);
    byAccount.set(s.accountId, arr);
  }
  const states = new Map<number, SnapState>();
  for (const [accountId, arr] of byAccount) {
    arr.sort((a, b) => (a.snapDate < b.snapDate ? -1 : a.snapDate > b.snapDate ? 1 : 0));
    states.set(accountId, { ptr: 0, lastValue: 0, rows: arr });
  }
  return states;
}

/**
 * Value of one pass (cash or investment) on `day`. On the final grid day, when
 * the caller PROVIDES a live map it is the AUTHORITATIVE source of truth: the
 * pass total is the sum over the live map and any account ABSENT from it
 * contributes 0. Otherwise each account carries its nearest snapshot
 * at-or-before `day`.
 *
 * The "provided ⇒ authoritative, even when empty" rule is load-bearing. An
 * investment account that still has stale per-account snapshot rows but NO live
 * holdings (e.g. every transaction was deleted) must read 0 today, NOT carry
 * its last stale snapshot forward — that mismatch is the "$0 net-worth hero but
 * the chart's final point spikes up" bug. The live map is empty in exactly that
 * case, so the previous `size > 0` guard SKIPPED the override and let the stale
 * value through. The route always passes a (possibly empty) map; tests/callers
 * that supply none (undefined) still fall back to carry-forward.
 *
 * Side effect: accumulates each account's per-day contribution into `perAccount`
 * (keyed by accountId, in displayCurrency) so the caller can build the FINLYNQ-128
 * tooltip breakdown. Returns the pass total (sum of those contributions).
 */
function sumPassForDay(
  states: Map<number, SnapState>,
  day: string,
  isFinalDay: boolean,
  liveByAccount: Map<number, LiveAccountValue> | undefined,
  rateMap: Map<string, number>,
  perAccount: Map<number, number>,
  basis: CurrencyBasis,
): number {
  // Under `native` NOTHING is converted: the stored native column and the live
  // override are both already in the account's own currency (LiveAccountValue
  // is documented "in account currency"), so the rate is 1 by construction.
  const native = basis === "native";
  if (isFinalDay && liveByAccount) {
    let sum = 0;
    for (const [accId, live] of liveByAccount) {
      const v = native
        ? live.value
        : convertWithRateMap(live.value, live.currency, rateMap);
      perAccount.set(accId, (perAccount.get(accId) ?? 0) + v);
      sum += v;
    }
    return sum;
  }
  let sum = 0;
  for (const [accId, st] of states) {
    while (st.ptr < st.rows.length && st.rows[st.ptr].snapDate <= day) {
      const snap = st.rows[st.ptr];
      st.lastValue = native
        ? snap.nativeMarketValue ?? 0
        : convertWithRateMap(snap.marketValue, snap.currency, rateMap);
      st.ptr++;
    }
    if (st.lastValue !== 0) {
      perAccount.set(accId, (perAccount.get(accId) ?? 0) + st.lastValue);
    }
    sum += st.lastValue;
  }
  return sum;
}

export function buildNetWorthHistory(
  input: BuildNetWorthHistoryInput,
): BuildNetWorthHistoryResult {
  const {
    period,
    displayCurrency,
    rateMap,
    cashSnapshots,
    liveCashByAccount,
    snapshots,
    liveInvestmentByAccount,
    today,
  } = input;

  const hasInvestmentData =
    snapshots.length > 0 || (liveInvestmentByAccount?.size ?? 0) > 0;

  // ── 1. Determine the first grid day ──────────────────────────────────────
  let firstDay: string;
  if (period === "all") {
    firstDay =
      minDate(earliestSnapDate(cashSnapshots), earliestSnapDate(snapshots)) ??
      today;
  } else {
    firstDay = addDaysISO(today, -PERIOD_DAYS[period]);
  }
  if (firstDay > today) firstDay = today;

  // ── 1b. Resolve the basis actually usable (FINLYNQ-303) ──────────────────
  // A native series requires a native value on every row the walk will CONSUME
  // (all-or-nothing — see the `basis` doc on the input type). Rows predating
  // the dual-basis rebuild have NULL native columns, so a request arriving in
  // that window downgrades to reporting rather than drawing a line that mixes
  // currencies point-to-point.
  //
  // Scoping to the consumed rows is load-bearing, not an optimization: callers
  // fetch from "1900-01-01" and let the period bound the GRID, so checking
  // every fetched row would let a single un-rebuilt row from years before the
  // window veto the native basis for a fully-rebuilt 6m range — which is
  // exactly what happened on dev. "Consumed" = every row on-or-after firstDay,
  // plus each account's seed row (its latest row strictly before firstDay),
  // which is what carry-forward starts the window from.
  const relevantRows = (rows: AccountSnapshot[]): AccountSnapshot[] => {
    const seedByAccount = new Map<number, AccountSnapshot>();
    const inWindow: AccountSnapshot[] = [];
    for (const s of rows) {
      if (s.snapDate >= firstDay) {
        inWindow.push(s);
        continue;
      }
      const seed = seedByAccount.get(s.accountId);
      if (!seed || s.snapDate > seed.snapDate) seedByAccount.set(s.accountId, s);
    }
    return [...seedByAccount.values(), ...inWindow];
  };
  const consumedRows = [
    ...relevantRows(cashSnapshots),
    ...relevantRows(snapshots),
  ];
  const nativeComplete =
    consumedRows.length > 0 &&
    consumedRows.every(
      (s) => s.nativeMarketValue != null && s.nativeCurrency != null,
    );
  const basisUsed: CurrencyBasis =
    input.basis === "native" && nativeComplete ? "native" : "reporting";

  // Under `native` every in-scope row shares ONE account currency (the caller
  // only permits native for a single account), so the first row names it; the
  // live map is the fallback when the range holds no stored rows yet.
  const seriesCurrency =
    basisUsed === "native"
      ? consumedRows[0]?.nativeCurrency ??
        [...(liveCashByAccount?.values() ?? []), ...(liveInvestmentByAccount?.values() ?? [])][0]
          ?.currency ??
        displayCurrency
      : displayCurrency;

  // ── 2. Per-account walking state for both passes ─────────────────────────
  const cashState = buildSnapStates(cashSnapshots);
  const invState = buildSnapStates(snapshots);

  // ── 3. Walk the daily grid ───────────────────────────────────────────────
  const series: NetWorthPoint[] = [];
  let day = firstDay;
  // Hard guard against pathological inputs (never loop more than ~30y of days).
  const MAX_DAYS = 30 * 366;
  let guard = 0;

  while (day <= today && guard < MAX_DAYS) {
    guard++;
    const isFinalDay = day === today;
    // Per-account contributions for THIS day (cash + investment merged). Both
    // passes write into the same map; an account never appears in both passes
    // (the readers partition on is_investment), so no key collision.
    const perAccount = new Map<number, number>();
    const cash = sumPassForDay(
      cashState, day, isFinalDay, liveCashByAccount, rateMap, perAccount, basisUsed,
    );
    const investment = sumPassForDay(
      invState, day, isFinalDay, liveInvestmentByAccount, rateMap, perAccount, basisUsed,
    );
    const breakdown: NetWorthBreakdownEntry[] = [];
    for (const [accountId, v] of perAccount) {
      breakdown.push({ accountId, value: Math.round(v * 100) / 100 });
    }
    series.push({
      date: day,
      value: Math.round((cash + investment) * 100) / 100,
      breakdown,
    });

    if (day === today) break;
    day = addDaysISO(day, 1);
  }

  return {
    series,
    hasInvestmentData,
    basisUsed,
    seriesCurrency,
    // Native removes the account→reporting conversion entirely, so a CASH
    // series is genuinely FX-free. An investment series still carries the
    // holding→account conversion done at build time, so it stays approximate.
    fxApproximation: basisUsed === "native" ? hasInvestmentData : true,
  };
}
