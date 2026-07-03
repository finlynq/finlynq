/**
 * MCP HTTP portfolio aggregator (FINLYNQ-109 extraction).
 *
 * Moved verbatim out of mcp-server/register-tools-pg.ts. Aggregates
 * buy/sell/dividend totals per portfolio_holding, decrypting the name in
 * memory. Several MCP tools need this shape — we can't use SQL GROUP BY
 * because each ciphertext row has a random IV.
 *
 * Exported for FINLYNQ-65 regression tests (imported back into
 * register-tools-pg.ts and re-exported there so existing test imports keep
 * resolving).
 */
import { sql } from "drizzle-orm";
import { normalizeDbRows } from "../db-utils";
import { decryptField } from "../crypto/envelope";
import { getRate } from "../fx-service";
import { isCashLegRow } from "./aggregation-predicates";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbLike = { execute: (query: ReturnType<typeof sql>) => Promise<any> };

async function q(db: DbLike, query: ReturnType<typeof sql>): Promise<Row[]> {
  return normalizeDbRows<Row>(await db.execute(query));
}

export type { DbLike };

export type HoldingAggRow = {
  name: string;
  buy_qty: number;
  buy_amount: number;
  sell_qty: number;
  sell_amount: number;
  dividends: number;
  first_purchase: string | null;
  purchases: number;
};

// Exported for FINLYNQ-65 regression tests in
// `tests/portfolio-aggregator-dividends-and-sellskip.test.ts`. The library
// aggregator `getHoldingsValueByAccount` (covered by FINLYNQ-49) does not
// compute `dividendsReceived` or realized-gain, so the issue #84 and #128
// realized-gain cases need this aggregator directly. Not part of the public
// MCP tool surface — internal-only export.
export async function aggregateHoldings(
  db: DbLike,
  userId: string,
  dek: Buffer | null,
  opts?: { since?: string; dividendsCategoryId?: number | null }
): Promise<(HoldingAggRow & { tx_count: number; net_quantity: number; last_activity: string | null; holding_id: number | null; currency: string })[]> {
  // Issue #236 (2026-05-10): the legacy `buysOnly: true` opt SQL-prefiltered
  // `t.amount < 0`, which silently dropped every WP-imported buy row
  // (Finlynq-native is `amt<0+qty>0`, WP convention is `amt>0+qty>0`). Buy
  // classification is `accumulate()`'s job — keying off `qty>0` per the
  // CLAUDE.md "Portfolio aggregator" invariant — and consumers that want
  // only the buy bucket read `a.buy_amount` (which `accumulate()` only
  // populates for `qty > 0` rows). Removing the opt entirely is safer than
  // leaving a footgun: a future caller passing `buysOnly: true` would
  // re-introduce the WP-drop bug. The patterns + rebalancing modes of
  // `get_investment_insights` (the only previous callers) now use the
  // canonical aggregator and reconcile against `get_portfolio_analysis`.
  const dateFilter = opts?.since ? sql`AND t.date >= ${opts.since}` : sql``;
  const dividendsCategoryId = opts?.dividendsCategoryId ?? null;

  // FK-bound aggregation. JOIN through holding_accounts (Section G) on
  // (holding_id, account_id) so the (holding, account) pair is the join
  // grain — forward-compatible with a canonical position split across
  // multiple accounts. JOIN to portfolio_holdings for the (encrypted)
  // display name; decrypt post-query and key the aggregator by that.
  // The decrypt cost is O(holdings) instead of O(transactions). Phase 5
  // (2026-04-29) removed the orphan-fallback path; every tx now has
  // portfolio_holding_id and the legacy text column is NULL.
  // CLAUDE.md "Portfolio aggregator" — qty>0 = buy regardless of amount
  // sign; preserved by `accumulate()` below.
  // Issue #84: t.category_id is plumbed through so accumulate() can match
  // dividends by the user's Dividends category id instead of the legacy
  // qty=0+amt>0 heuristic.
  // Issue #96: LEFT JOIN to the cash-leg sibling for multi-currency trade
  // pairs. SELECT cash.amount as cash_amount; accumulate() prefers it on
  // a paired buy row. Cash leg is identified by (same user, same
  // trade_link_id, qty=0 or NULL, different id).
  // Issue #129: SELECT t.entered_amount, t.entered_currency, ph.currency
  // (holding currency), cash.entered_amount, cash.entered_currency, and
  // a.currency (account currency) so accumulate() can normalize each
  // row's amount into the holding's own currency. Without this, a USD
  // ETF held inside a CAD account summed cost basis in CAD and tagged
  // it USD, producing a double-FX inflation downstream.
  type Agg = HoldingAggRow & { tx_count: number; net_quantity: number; last_activity: string | null; holding_id: number | null; currency: string };
  // Issue #86: key by holding_id (not display name) so two holdings sharing
  // a name across accounts (e.g. VUN.TO in TFSA + RRSP) stay distinct rows.
  // Phase 6 (2026-04-29) eliminated orphan rows; t.portfolio_holding_id is
  // never null here. Skip-and-warn any row that surprises us with a null FK.
  const out = new Map<number, Agg>();
  // Issue #128: SELECT t.trade_link_id + t.kind so accumulate() can skip
  // paired cash-leg rows from BOTH the buy- and sell-side branches. Under
  // the Phase 2 sign convention (2026-05-25), `buy_cash_leg`/`sell_cash_leg`
  // rows carry non-zero amount + qty so `trade_link_id IS NOT NULL AND
  // amount = 0` no longer matches them — kind is the new discriminator.
  // Stream D Phase 4: ph.name dropped — read ph.name_ct only.
  // FINLYNQ-173: SELECT t.related_holding_id + the paying security's
  // name_ct/currency (rph.*) so the dividend branch in accumulate() can
  // re-attribute a dividend off the cash sleeve onto the security that
  // earned it. A dividend row lands on the cash sleeve
  // (portfolio_holding_id = USD_Cash) but carries related_holding_id =
  // the paying security; without re-attribution every ticker's dividend
  // piled onto the cash sleeve's Dividends + Total Return.
  const fkRows = await q(db, sql`
    SELECT t.portfolio_holding_id, t.related_holding_id, t.amount, t.quantity, t.date, t.category_id,
           t.trade_link_id, t.kind,
           t.entered_amount, t.entered_currency, t.currency AS row_currency,
           a.currency AS account_currency,
           ph.name_ct AS holding_name_ct,
           ph.currency AS holding_currency,
           rph.name_ct AS related_name_ct,
           rph.currency AS related_currency,
           cash.amount AS cash_amount, cash.id AS cash_id,
           cash.entered_amount AS cash_entered_amount,
           cash.entered_currency AS cash_entered_currency,
           cash.currency AS cash_row_currency
    FROM transactions t
    INNER JOIN holding_accounts ha
      ON ha.holding_id = t.portfolio_holding_id
     AND ha.account_id = t.account_id
     AND ha.user_id = ${userId}
    INNER JOIN accounts a ON a.id = t.account_id
    LEFT JOIN portfolio_holdings ph ON t.portfolio_holding_id = ph.id
    LEFT JOIN portfolio_holdings rph ON t.related_holding_id = rph.id
    LEFT JOIN transactions cash
      ON cash.user_id = ${userId}
     AND cash.trade_link_id IS NOT NULL
     AND cash.trade_link_id = t.trade_link_id
     AND cash.id <> t.id
     AND COALESCE(cash.quantity, 0) = 0
    WHERE t.user_id = ${userId}
      AND t.portfolio_holding_id IS NOT NULL
      ${dateFilter}
  `);

  // Issue #129: pre-resolve every (entered_currency → holding_currency) FX
  // hop into a synchronous cache so accumulate() can stay synchronous.
  // getRate is awaited once per distinct cross-currency pair.
  const todayStr = new Date().toISOString().split("T")[0];
  const fxCache = new Map<string, number>();
  const fxKey = (from: string, to: string) => `${from.toUpperCase()}->${to.toUpperCase()}`;
  const neededPairs = new Set<string>();
  for (const r of fkRows) {
    const holdingCcy = String(r.holding_currency ?? "").toUpperCase();
    if (!holdingCcy) continue;
    const qty = Number(r.quantity ?? 0);
    // Buy-side: entered_currency from this row OR cash leg if paired.
    if (qty > 0) {
      const isPaired = r.cash_id != null;
      const enteredCcy = isPaired
        ? String(r.cash_entered_currency ?? r.cash_row_currency ?? r.account_currency ?? "").toUpperCase()
        : String(r.entered_currency ?? r.row_currency ?? r.account_currency ?? "").toUpperCase();
      if (enteredCcy && enteredCcy !== holdingCcy) neededPairs.add(fxKey(enteredCcy, holdingCcy));
    } else if (qty < 0) {
      const enteredCcy = String(r.entered_currency ?? r.row_currency ?? r.account_currency ?? "").toUpperCase();
      if (enteredCcy && enteredCcy !== holdingCcy) neededPairs.add(fxKey(enteredCcy, holdingCcy));
    }
    // Dividends: entered_currency on the row, FX'd into the ATTRIBUTION
    // holding's currency — the paying security (related_currency) when present,
    // else the cash sleeve (FINLYNQ-173).
    const enteredCcy = String(r.entered_currency ?? r.row_currency ?? r.account_currency ?? "").toUpperCase();
    const divTargetCcy = String(r.related_currency ?? r.holding_currency ?? "").toUpperCase();
    if (enteredCcy && divTargetCcy && enteredCcy !== divTargetCcy) neededPairs.add(fxKey(enteredCcy, divTargetCcy));
  }
  for (const key of neededPairs) {
    const [from, to] = key.split("->");
    fxCache.set(key, await getRate(from, to, todayStr, userId));
  }
  const fxLookup = (from: string, to: string): number => {
    const f = (from || "").toUpperCase();
    const t = (to || "").toUpperCase();
    if (!f || !t || f === t) return 1;
    return fxCache.get(fxKey(f, t)) ?? 1;
  };

  // FINLYNQ-173: per-holding decrypt cache so a dividend's PAYING SECURITY
  // (related_holding_id) row can be created/looked-up with its own decrypted
  // name even when the security appears only as a related_holding_id (no
  // buy/sell rows of its own in this window).
  const decryptHoldingName = (nameCt: unknown): string => {
    if (!nameCt || !dek) return "";
    try {
      return decryptField(dek, String(nameCt)) ?? "";
    } catch {
      return "";
    }
  };

  for (const r of fkRows) {
    const hid = Number(r.portfolio_holding_id ?? 0) || null;
    if (hid == null) continue; // shouldn't happen post-Phase-6; defensive skip
    // Stream D Phase 4: only the ciphertext column remains. Decrypt or skip.
    const name = decryptHoldingName(r.holding_name_ct);
    // Skip rows whose holding_name_ct failed to decrypt or DEK is missing
    // (stdio transport, or a DEK mismatch). The downstream UI relies on a
    // non-empty name.
    if (!name || name.startsWith("v1:")) continue;
    // FINLYNQ-173: resolve the dividend's attribution target (the paying
    // security when related_holding_id is set, else this row's own holding).
    const relatedId = Number(r.related_holding_id ?? 0) || null;
    const relatedName = relatedId != null ? decryptHoldingName(r.related_name_ct) : "";
    const divTarget =
      relatedId != null && relatedName && !relatedName.startsWith("v1:")
        ? {
            holdingId: relatedId,
            name: relatedName,
            currency: String(r.related_currency ?? r.holding_currency ?? "").toUpperCase(),
          }
        : null;
    accumulate(out, hid, name, r, dividendsCategoryId, fxLookup, divTarget);
  }

  return Array.from(out.values()).sort((a, b) => b.buy_amount - a.buy_amount);
}

/** Shared accumulator. Keyed by holding_id (issue #86) — display name is
 *  carried as a row field but never used for lookup.
 *
 *  Issue #129: cost basis (buy_amount, sell_amount, dividends) is normalized
 *  into the holding's own currency (`r.holding_currency`). Cross-currency
 *  rows (e.g. a USD ETF inside a CAD account where `entered_currency=USD`
 *  and `account_currency=CAD`) are FX-converted via `fxLookup`. Same-currency
 *  rows pass through untouched (fxLookup returns 1). The output is then
 *  consistently in `holding_currency`, so callers can `tagAmount(buyAmt,
 *  holding.currency, "account")` correctly. */
function accumulate(
  out: Map<number, HoldingAggRow & { tx_count: number; net_quantity: number; last_activity: string | null; holding_id: number | null; currency: string }>,
  holdingId: number,
  name: string,
  r: Row,
  dividendsCategoryId: number | null,
  fxLookup: (from: string, to: string) => number,
  // FINLYNQ-173: dividend-attribution target (the paying security via
  // related_holding_id). When set, the dividend branch credits THIS holding's
  // row instead of the row's own `holdingId` (the cash sleeve). null → no
  // related holding stamped, dividend stays on the row's own holding.
  divTarget?: { holdingId: number; name: string; currency: string } | null,
): void {
  const qty = Number(r.quantity ?? 0);
  const amt = Number(r.amount);
  const d = String(r.date);
  const catId = r.category_id != null ? Number(r.category_id) : null;
  // Issue #129: holding currency is the canonical accounting unit for this
  // aggregator's per-holding totals. Falls back to the row's account
  // currency only as a last resort (no portfolio_holdings join, e.g.
  // legacy data) — never to USD/CAD silently.
  const holdingCcy = String(r.holding_currency ?? r.account_currency ?? r.row_currency ?? "").toUpperCase();
  const accountCcy = String(r.account_currency ?? r.row_currency ?? "").toUpperCase();
  const enteredCcy = String(r.entered_currency ?? r.row_currency ?? accountCcy).toUpperCase();
  const cashEnteredCcy = String(r.cash_entered_currency ?? r.cash_row_currency ?? accountCcy).toUpperCase();

  const row = out.get(holdingId) ?? {
    name,
    buy_qty: 0,
    buy_amount: 0,
    sell_qty: 0,
    sell_amount: 0,
    dividends: 0,
    first_purchase: null as string | null,
    purchases: 0,
    tx_count: 0,
    net_quantity: 0,
    last_activity: null as string | null,
    holding_id: holdingId,
    currency: holdingCcy || "CAD",
  };
  row.tx_count += 1;
  row.net_quantity += qty;
  if (!row.last_activity || d > row.last_activity) row.last_activity = d;
  // qty>0 = buy (regardless of amt sign — Finlynq-native is amt<0+qty>0,
  // WP/ZIP convention is amt>0+qty>0). qty<0 = sell. The buy/sell branches
  // come first so dividend reinvestments (qty>0, amt<0, category=Dividends)
  // still count toward shares held.
  //
  // Issue #84: dividends are matched by category_id, not the legacy
  // `qty=0 AND amt>0` heuristic. That heuristic silently dropped dividend
  // reinvestments and withholding-tax / negative-correction rows. When the
  // user has no Dividends category (dividendsCategoryId == null), the
  // branch is skipped and `dividends` sums to 0.
  // Issue #128 (Phase 2 update, 2026-05-26): paired cash-leg rows are
  // skipped from BOTH the buy- and sell-side branches. Under Phase 2 sign
  // convention, sell_cash_leg has qty>0 (would phantom-count as a buy on
  // the cash sleeve) and buy_cash_leg has qty<0 (would phantom-count as a
  // sell). The discriminator is `kind IN ('buy_cash_leg', 'sell_cash_leg')`;
  // legacy pre-Phase-2 cash legs (kind NULL, amount=0) are caught by the
  // fallback `trade_link_id IS NOT NULL AND amount = 0`.
  // FINLYNQ-106: the #128 paired cash-leg skip now lives in ONE place
  // (src/lib/portfolio/aggregation-predicates.ts) shared with the two SQL
  // aggregators (holdings-value.ts + /api/portfolio/overview). `amt` is the
  // already-coerced Number(r.amount); pass it through so the legacy
  // `amount = 0` fallback matches identically to the SQL form.
  const isPairedCashLeg = isCashLegRow({ kind: r.kind ?? null, tradeLinkId: r.trade_link_id ?? null, amount: amt });
  if (isPairedCashLeg) {
    // Paired cash-leg sibling — contributes neither buy nor sell here.
    // (Cash-sleeve qty is tracked separately via SUM(quantity) per
    // CLAUDE.md "Portfolio aggregator"; this aggregation is for the
    // realized-gain calc only.)
  } else if (qty > 0) {
    row.buy_qty += qty;
    // Issue #96: when a paired cash-leg sibling is present (multi-currency
    // trade pair), use its entered_amount as cost basis instead of this
    // stock leg's amount. cash_amount is null when no pair exists (legacy /
    // single-currency trades) — fall back to the stock leg's own amount.
    // Issue #129: prefer entered_amount (in entered_currency) so the
    // cross-currency normalization below applies; entered_amount falls
    // back to amount when it's null (un-backfilled legacy rows).
    const isPaired = r.cash_id != null;
    let buyCostInEntered: number;
    let buyCostCcy: string;
    if (isPaired) {
      const cashEnteredAmt = r.cash_entered_amount != null ? Number(r.cash_entered_amount) : NaN;
      const cashAmt = Number.isFinite(cashEnteredAmt) ? cashEnteredAmt : Number(r.cash_amount ?? 0);
      buyCostInEntered = Math.abs(cashAmt);
      buyCostCcy = cashEnteredCcy;
    } else {
      const enteredAmt = r.entered_amount != null ? Number(r.entered_amount) : NaN;
      buyCostInEntered = Number.isFinite(enteredAmt) ? Math.abs(enteredAmt) : Math.abs(amt);
      buyCostCcy = enteredCcy;
    }
    const fx = holdingCcy ? fxLookup(buyCostCcy, holdingCcy) : 1;
    row.buy_amount += buyCostInEntered * fx;
    row.purchases += 1;
    if (!row.first_purchase || d < row.first_purchase) row.first_purchase = d;
  } else if (qty < 0) {
    row.sell_qty += Math.abs(qty);
    // Issue #129: sell amount in entered_currency, FX-normalized to
    // holding currency.
    const enteredAmt = r.entered_amount != null ? Number(r.entered_amount) : NaN;
    const sellAmtInEntered = Number.isFinite(enteredAmt) ? Math.abs(enteredAmt) : Math.abs(amt);
    const fx = holdingCcy ? fxLookup(enteredCcy, holdingCcy) : 1;
    row.sell_amount += sellAmtInEntered * fx;
  }
  // Persist the row's own holding (buy/sell/qty/tx_count) before handling the
  // dividend, which may credit a DIFFERENT holding (the paying security).
  out.set(holdingId, row);

  if (dividendsCategoryId !== null && catId === dividendsCategoryId) {
    // Issue #129: dividends in entered_currency, FX-normalized to the holding
    // currency. Sign preserved (dividends contribute positive; withholding-
    // tax / corrections contribute negative — see issue #84).
    // FINLYNQ-173: credit the PAYING SECURITY (divTarget) not the cash sleeve.
    // A dividend lands on the cash sleeve (portfolio_holding_id) but carries
    // related_holding_id = the security; route it there so the cash sleeve's
    // Dividends column reads 0. When no related holding was stamped (legacy /
    // genuine cash interest) divTarget is null and the dividend stays on the
    // row's own holding — preserving the grand total either way.
    const enteredAmt = r.entered_amount != null ? Number(r.entered_amount) : NaN;
    const divInEntered = Number.isFinite(enteredAmt) ? enteredAmt : amt;
    const targetId = divTarget?.holdingId ?? holdingId;
    const targetCcy = (divTarget?.currency || holdingCcy).toUpperCase();
    const fx = targetCcy ? fxLookup(enteredCcy, targetCcy) : 1;
    // Resolve (or create) the attribution row. When the security has no
    // buy/sell rows of its own in this window the row won't exist yet.
    const targetRow = out.get(targetId) ?? {
      name: divTarget?.name ?? name,
      buy_qty: 0,
      buy_amount: 0,
      sell_qty: 0,
      sell_amount: 0,
      dividends: 0,
      first_purchase: null as string | null,
      purchases: 0,
      tx_count: 0,
      net_quantity: 0,
      last_activity: null as string | null,
      holding_id: targetId,
      currency: targetCcy || "CAD",
    };
    targetRow.dividends += divInEntered * fx;
    if (!targetRow.last_activity || d > targetRow.last_activity) targetRow.last_activity = d;
    out.set(targetId, targetRow);
  }
}
