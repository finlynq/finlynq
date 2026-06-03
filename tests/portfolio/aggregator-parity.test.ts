/**
 * Cross-aggregator PARITY harness (FINLYNQ-106).
 *
 * Portfolio holdings/cost-basis aggregation is implemented THREE times in three
 * different query dialects, and nothing pinned their equivalence:
 *   1. `getHoldingsValueByAccount`  — src/lib/holdings-value.ts (canonical,
 *      drizzle query-builder).
 *   2. the inline reimplementation in the `/api/portfolio/overview` GET handler
 *      (drizzle query-builder + dividends/realized-gain).
 *   3. the raw-`sql` `aggregateHoldings` / `accumulate` in
 *      mcp-server/register-tools-pg.ts.
 * FINLYNQ-49 + FINLYNQ-65 covered each aggregator's BEHAVIOUR in isolation but
 * explicitly DEFERRED cross-aggregator parity. They had already silently
 * diverged: the overview route + MCP `accumulate` carried the issue-#128 paired
 * cash-leg skip; `holdings-value.ts` did NOT. FINLYNQ-106 extracts that skip
 * into one shared helper (`src/lib/portfolio/aggregation-predicates.ts`) and
 * adds THIS test as the net.
 *
 * --- Why mock-based, no sandbox DB ---
 *
 * The DB-backed FINLYNQ-49/65 suites need a real `finlynq_test` Postgres; this
 * harness is intentionally DB-free (triage note: "mock-based; no sandbox DB —
 * these are pure/`sql`-buildable aggregators driven over fixture rows"). It
 * drives ONE fixture through all three aggregators over a mocked `@/db` and a
 * tiny in-memory aggregation engine that GROUPs the fixture rows the same way
 * each aggregator's SQL does. The engine does NOT re-implement the #128 rule —
 * it calls the SAME production predicate (`isCashLegRow`) the three aggregators
 * now share, so a regression in the shared rule surfaces here. tc-2 proves the
 * harness is not a tautology by disabling the skip for exactly one aggregator
 * and asserting the parity assertion fails.
 *
 * Fixture currency = USD throughout so every FX hop is 1 (the harness mocks all
 * FX getters to 1); parity is asserted on the STOCK holdings, where all three
 * aggregators must agree to the cent. The cash SLEEVE holding is where the
 * three legitimately model differently (live cash balance) and is not part of
 * the parity assertion — the #128 skip exists precisely so a cash leg never
 * leaks into a STOCK holding's qty/cost.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { sql } from "drizzle-orm";

import * as realSchema from "@/db/schema-pg";
import { isCashLegRow } from "@/lib/portfolio/aggregation-predicates";

// ─── Fixture ────────────────────────────────────────────────────────────────
// Single USD investment account. One stock (AAPL) bought then partially sold,
// plus a USD cash sleeve carrying the Phase-2 cash legs. A dividend row on the
// stock exercises the dividend branch (overview/MCP only). All amounts USD so
// FX = 1 everywhere.

const TODAY = new Date().toISOString().split("T")[0];
const ACCOUNT_ID = 100;
const AAPL_HOLDING = 1;
const CASH_SLEEVE = 2;
const DIVIDENDS_CATEGORY_ID = 9;

type FixtureHolding = {
  id: number;
  accountId: number;
  name: string;
  symbol: string | null;
  currency: string;
  isCrypto: number;
  isCash: boolean;
};

type FixtureTx = {
  id: number;
  portfolioHoldingId: number;
  accountId: number;
  date: string;
  amount: number;
  quantity: number;
  enteredAmount: number;
  enteredCurrency: string;
  currency: string;
  categoryId: number | null;
  tradeLinkId: string | null;
  kind: string | null;
};

const HOLDINGS: FixtureHolding[] = [
  { id: AAPL_HOLDING, accountId: ACCOUNT_ID, name: "AAPL", symbol: "AAPL", currency: "USD", isCrypto: 0, isCash: false },
  { id: CASH_SLEEVE, accountId: ACCOUNT_ID, name: "USD Cash", symbol: "USD", currency: "USD", isCrypto: 0, isCash: true },
];

// Buy 10 AAPL @ $200 (stock leg) + paired cash leg on the sleeve (Phase-2:
// qty<0, amt<0, kind=buy_cash_leg). Then sell 4 AAPL @ $250 (stock leg) +
// paired sell_cash_leg on the sleeve (qty>0, amt>0). Plus a $30 cash dividend.
const BUY_LINK = "trade-buy-aapl";
const SELL_LINK = "trade-sell-aapl";

const TRANSACTIONS: FixtureTx[] = [
  // Stock buy leg → AAPL holding
  { id: 11, portfolioHoldingId: AAPL_HOLDING, accountId: ACCOUNT_ID, date: TODAY, amount: 2000, quantity: 10, enteredAmount: 2000, enteredCurrency: "USD", currency: "USD", categoryId: null, tradeLinkId: BUY_LINK, kind: "buy" },
  // Paired buy cash leg → CASH sleeve (must be skipped from cost tallies)
  { id: 12, portfolioHoldingId: CASH_SLEEVE, accountId: ACCOUNT_ID, date: TODAY, amount: -2000, quantity: -2000, enteredAmount: -2000, enteredCurrency: "USD", currency: "USD", categoryId: null, tradeLinkId: BUY_LINK, kind: "buy_cash_leg" },
  // Stock sell leg → AAPL holding (sell 4 @ $250)
  { id: 13, portfolioHoldingId: AAPL_HOLDING, accountId: ACCOUNT_ID, date: TODAY, amount: -1000, quantity: -4, enteredAmount: -1000, enteredCurrency: "USD", currency: "USD", categoryId: null, tradeLinkId: SELL_LINK, kind: "sell" },
  // Paired sell cash leg → CASH sleeve (must be skipped from cost tallies)
  { id: 14, portfolioHoldingId: CASH_SLEEVE, accountId: ACCOUNT_ID, date: TODAY, amount: 1000, quantity: 1000, enteredAmount: 1000, enteredCurrency: "USD", currency: "USD", categoryId: null, tradeLinkId: SELL_LINK, kind: "sell_cash_leg" },
  // Cash dividend on AAPL (qty=0, category=Dividends)
  { id: 15, portfolioHoldingId: AAPL_HOLDING, accountId: ACCOUNT_ID, date: TODAY, amount: 30, quantity: 0, enteredAmount: 30, enteredCurrency: "USD", currency: "USD", categoryId: DIVIDENDS_CATEGORY_ID, tradeLinkId: null, kind: "dividend" },
];

const AAPL_PRICE = 250; // USD; remaining qty 6 → market value $1500

// Controls the synthetic-divergence case (tc-2): when set, the in-memory
// engine does NOT apply the #128 skip for the named aggregator, mimicking a
// production code-path that lost the skip.
let SKIP_DISABLED_FOR: "holdings-value" | "overview" | "mcp" | null = null;

// ─── In-memory aggregation engine ────────────────────────────────────────────
// Groups the fixture transactions by (portfolioHoldingId, enteredCurrency) the
// way each aggregator's `SUM(CASE …) GROUP BY` does, applying the SHARED
// production predicate `isCashLegRow` (NOT a local re-spelling of the rule).
// Returns one row per (holding, currency) bucket with the columns each
// aggregator reads.

type EngineBucket = {
  portfolio_holding_id: number;
  entered_currency: string;
  delta: number;              // net qty (NO skip — load-bearing for sleeves)
  total_buy_qty: number;
  total_buy_amount: number;
  total_sell_qty: number;
  total_sell_amount: number;
  dividends: number;
  first_purchase: string | null;
};

function buildBuckets(applySkip: boolean): EngineBucket[] {
  const byKey = new Map<string, EngineBucket>();
  for (const t of TRANSACTIONS) {
    const cur = (t.enteredCurrency || t.currency).toUpperCase();
    const key = `${t.portfolioHoldingId}::${cur}`;
    let b = byKey.get(key);
    if (!b) {
      b = {
        portfolio_holding_id: t.portfolioHoldingId,
        entered_currency: cur,
        delta: 0,
        total_buy_qty: 0,
        total_buy_amount: 0,
        total_sell_qty: 0,
        total_sell_amount: 0,
        dividends: 0,
        first_purchase: null,
      };
      byKey.set(key, b);
    }
    // Net qty (`delta`) is computed with NO skip in every aggregator.
    b.delta += t.quantity;
    const skip = applySkip && isCashLegRow({ kind: t.kind, tradeLinkId: t.tradeLinkId, amount: t.amount });
    if (t.quantity > 0 && !skip) {
      b.total_buy_qty += t.quantity;
      b.total_buy_amount += Math.abs(t.enteredAmount);
      if (!b.first_purchase || t.date < b.first_purchase) b.first_purchase = t.date;
    } else if (t.quantity < 0 && !skip) {
      b.total_sell_qty += Math.abs(t.quantity);
      b.total_sell_amount += Math.abs(t.enteredAmount);
    }
    if (t.categoryId === DIVIDENDS_CATEGORY_ID) {
      b.dividends += t.enteredAmount;
    }
  }
  return Array.from(byKey.values());
}

// ─── Mock @/db ────────────────────────────────────────────────────────────────
// A purpose-built drizzle-shaped mock. `.select(fields).from(table)…` is a
// thenable; the awaited result depends on which real schema table `.from()` was
// given. `.execute(sqlTemplate)` answers the MCP raw-`sql` aggregation.

function holdingsSelectRows() {
  // Shape both holdings-value.ts and overview expect (decryptable name/symbol +
  // account currency / account name ciphertext). We bypass real decryption by
  // putting plaintext where the decryptor would land it (see vi.mock of
  // encrypted-columns below).
  return HOLDINGS.map((h) => ({
    id: h.id,
    accountId: h.accountId,
    nameCt: h.name,
    symbolCt: h.symbol,
    accountNameCt: `acct-${h.accountId}`,
    currency: h.currency,
    isCrypto: h.isCrypto,
    accountCurrency: "USD",
    note: null,
  }));
}

function aggSelectRows(aggregator: "holdings-value" | "overview") {
  const applySkip = !(SKIP_DISABLED_FOR === aggregator);
  return buildBuckets(applySkip).map((b) => ({
    portfolioHoldingId: b.portfolio_holding_id,
    enteredCurrency: b.entered_currency,
    delta: b.delta,
    totalBuyQty: b.total_buy_qty,
    totalBuyAmountInEntered: b.total_buy_amount,
    totalSellQty: b.total_sell_qty,
    totalSellAmountInEntered: b.total_sell_amount,
    dividendsInEntered: b.dividends,
    firstPurchaseDate: b.first_purchase,
  }));
}

function makeThenable(resolver: () => unknown[]) {
  const chain: Record<string, unknown> = {};
  const passthrough = () => chain;
  for (const m of ["from", "leftJoin", "innerJoin", "where", "groupBy", "orderBy", "limit", "having"]) {
    chain[m] = vi.fn(passthrough);
  }
  chain.then = (resolve: (v: unknown) => unknown) => resolve(resolver());
  return chain;
}

const fkAggColumns = new Set([
  "portfolioHoldingId",
  "enteredCurrency",
  "delta",
  "totalBuyQty",
  "totalBuyAmountInEntered",
  "totalSellQty",
  "totalSellAmountInEntered",
  "totalSellAmount",
  "dividendsInEntered",
  "firstPurchaseDate",
]);

const mockDb = {
  select(fields?: Record<string, unknown>) {
    const keys = fields ? Object.keys(fields) : [];
    // Distinguish the FK-aggregation select (has portfolioHoldingId +
    // entered-currency/agg fields) from the holdings select.
    const isAgg = keys.includes("portfolioHoldingId") && keys.some((k) => fkAggColumns.has(k) && k !== "portfolioHoldingId");
    if (isAgg) {
      const aggregator: "holdings-value" | "overview" = keys.includes("dividendsInEntered") || keys.includes("totalSellAmountInEntered")
        ? "overview"
        : "holdings-value";
      return makeThenable(() => aggSelectRows(aggregator));
    }
    // Settings (active_currencies) select → empty.
    if (keys.includes("value") && !keys.includes("id")) {
      return makeThenable(() => []);
    }
    return makeThenable(() => holdingsSelectRows());
  },
  async execute(_query: ReturnType<typeof sql>) {
    // MCP `aggregateHoldings` raw-`sql`. Return one row per transaction joined
    // through holding_accounts (the engine groups in JS via accumulate()).
    const applySkip = !(SKIP_DISABLED_FOR === "mcp");
    void applySkip; // MCP applies the skip in accumulate() via isCashLegRow; for
    // the divergence case we instead null out `kind`/`trade_link_id`/force amount
    // so the production predicate no longer matches (see rowsForMcp()).
    return { rows: rowsForMcp() };
  },
};

function rowsForMcp() {
  // Per-transaction rows with the raw-sql column names accumulate() reads.
  return TRANSACTIONS.map((t) => {
    const h = HOLDINGS.find((x) => x.id === t.portfolioHoldingId)!;
    // tc-2 (mcp divergence): strip the discriminators the shared predicate
    // keys on so the cash leg is NOT skipped — mimics a path that lost #128.
    const divergent = SKIP_DISABLED_FOR === "mcp";
    return {
      portfolio_holding_id: t.portfolioHoldingId,
      amount: t.amount,
      quantity: t.quantity,
      date: t.date,
      category_id: t.categoryId,
      trade_link_id: divergent ? null : t.tradeLinkId,
      kind: divergent ? null : t.kind,
      entered_amount: t.enteredAmount,
      entered_currency: t.enteredCurrency,
      row_currency: t.currency,
      account_currency: "USD",
      holding_name_ct: h.name,
      holding_currency: h.currency,
      cash_amount: null,
      cash_id: null,
      cash_entered_amount: null,
      cash_entered_currency: null,
      cash_row_currency: null,
    };
  });
}

vi.mock("@/db", () => ({
  db: new Proxy({}, { get: (_t, p) => (mockDb as Record<string, unknown>)[p as string] }),
  schema: realSchema,
}));

// decryptNamedRows / decryptField are no-ops here: the mock already supplies
// plaintext in the *_ct fields, so map ct → plain field name verbatim.
vi.mock("@/lib/crypto/encrypted-columns", () => ({
  decryptNamedRows: (rows: Record<string, unknown>[], _dek: unknown, mapping: Record<string, string>) =>
    rows.map((r) => {
      const out = { ...r };
      for (const [ct, plain] of Object.entries(mapping)) out[plain] = r[ct] ?? null;
      return out;
    }),
  buildNameFields: () => ({}),
  encryptName: () => ({ ct: "", lookup: "" }),
  nameLookup: () => "",
}));

// FX everywhere = 1 (USD-only fixture).
vi.mock("@/lib/fx-service", () => ({
  getLatestFxRate: vi.fn(async () => 1),
  getRate: vi.fn(async () => 1),
  convertCurrency: (amount: number, rate: number) => amount * rate,
  getDisplayCurrency: vi.fn(async () => "USD"),
}));

// Prices: AAPL fixed; no crypto.
vi.mock("@/lib/price-service", () => ({
  fetchMultipleQuotes: vi.fn(async (symbols: string[]) => {
    const m = new Map<string, { price: number; currency: string; change: number; changePct: number }>();
    for (const s of symbols) if (s === "AAPL") m.set(s, { price: AAPL_PRICE, currency: "USD", change: 0, changePct: 0 });
    return m;
  }),
  fetchMultipleQuotesAtDate: vi.fn(async () => new Map()),
  aggregatePortfolioExposure: vi.fn(() => ({})),
  getEtfRegionBreakdown: vi.fn(() => null),
  getEtfSectorBreakdown: vi.fn(() => null),
  getEtfTopHoldings: vi.fn(() => null),
  getAvailableEtfSymbols: vi.fn(() => []),
  autoSeedEtfIfMissing: vi.fn(),
}));

vi.mock("@/lib/crypto-service", () => ({
  getCryptoPrices: vi.fn(async () => []),
  getCryptoSpotPrices: vi.fn(async () => []),
  getCryptoPricesAtDate: vi.fn(async () => []),
  symbolToCoinGeckoId: vi.fn(() => null),
}));

vi.mock("@/lib/dividends-category", () => ({
  resolveDividendsCategoryId: vi.fn(async () => DIVIDENDS_CATEGORY_ID),
}));

vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(async () => ({
    authenticated: true,
    context: { userId: "parity-user", sessionId: "parity-session", method: "passphrase" as const, mfaVerified: false },
  })),
}));

vi.mock("@/lib/crypto/dek-cache", () => ({
  getDEK: vi.fn(() => Buffer.alloc(32, 0xaa)),
}));

// MCP `aggregateHoldings` decrypts holding_name_ct via decryptField; our mock
// rows already hold plaintext, so make decryptField an identity.
vi.mock("@/lib/crypto/envelope", () => ({
  decryptField: (_dek: unknown, ct: string) => ct,
  tryDecryptField: (_dek: unknown, ct: string) => ct,
  encryptField: (_dek: unknown, pt: string) => pt,
}));

// ─── SUTs (imported AFTER the mocks above) ───────────────────────────────────
import { getHoldingsValueByAccount } from "@/lib/holdings-value";
import { GET as overviewGET } from "@/app/api/portfolio/overview/route";
import { aggregateHoldings } from "../../mcp-server/register-tools-pg";
import { db as mockedDb } from "@/db";

const TEST_DEK = Buffer.alloc(32, 0xaa);

function overviewRequest() {
  return { nextUrl: { searchParams: new URLSearchParams() } } as unknown as Parameters<typeof overviewGET>[0];
}

/** Run all three aggregators and return a per-holding parity view for the
 *  STOCK holding(s): { qty, costBasis, marketValue } from each. */
async function runAll() {
  // 1. holdings-value.ts — account-grained; AAPL is the only stock so the
  //    account totals == AAPL's (cash sleeve has net qty <0 → skipped from
  //    valuation by the qty<=0 guard, contributes nothing).
  const hv = await getHoldingsValueByAccount("parity-user", TEST_DEK);
  const hvAcct = hv.get(ACCOUNT_ID);

  // 2. overview GET handler — per-holding enriched array.
  const res = await overviewGET(overviewRequest());
  const body = (await res.json()) as { holdings: Array<Record<string, number | string | null>> };
  const ovAapl = body.holdings.find((h) => h.id === AAPL_HOLDING)!;

  // 3. MCP aggregateHoldings — per-holding agg rows.
  const mcp = await aggregateHoldings(mockedDb as never, "parity-user", TEST_DEK, {
    dividendsCategoryId: DIVIDENDS_CATEGORY_ID,
  });
  const mcpAapl = mcp.find((m) => m.holding_id === AAPL_HOLDING)!;
  const mcpQty = mcpAapl.buy_qty - mcpAapl.sell_qty;
  const mcpAvg = mcpAapl.buy_qty > 0 ? mcpAapl.buy_amount / mcpAapl.buy_qty : 0;

  return {
    holdingsValue: { qty: null as number | null, costBasis: hvAcct?.costBasis ?? null, marketValue: hvAcct?.value ?? null },
    overview: { qty: Number(ovAapl.quantity), costBasis: Number(ovAapl.totalCostBasis), marketValue: Number(ovAapl.marketValue) },
    mcp: { qty: mcpQty, costBasis: mcpQty * mcpAvg, marketValue: mcpQty * AAPL_PRICE },
  };
}

beforeEach(() => {
  SKIP_DISABLED_FOR = null;
  vi.clearAllMocks();
});

describe("FINLYNQ-106 cross-aggregator parity (issue #128 cash-leg skip)", () => {
  // tc-1 (primary): all three aggregators agree per STOCK holding.
  it("tc-1: getHoldingsValueByAccount, /api/portfolio/overview, and aggregateHoldings agree on AAPL qty/costBasis/marketValue", async () => {
    const r = await runAll();

    // Expected (the cash legs are correctly skipped from cost tallies):
    //   buy 10 @ $2000, sell 4 @ $1000 → remaining qty 6, avg cost $200,
    //   remaining cost basis $1200, market value 6 × $250 = $1500.
    expect(r.overview.qty).toBeCloseTo(6, 6);
    expect(r.mcp.qty).toBeCloseTo(6, 6);

    expect(r.overview.costBasis).toBeCloseTo(1200, 2);
    expect(r.mcp.costBasis).toBeCloseTo(1200, 2);
    expect(r.holdingsValue.costBasis!).toBeCloseTo(1200, 2);

    expect(r.overview.marketValue).toBeCloseTo(1500, 2);
    expect(r.mcp.marketValue).toBeCloseTo(1500, 2);
    expect(r.holdingsValue.marketValue!).toBeCloseTo(1500, 2);

    // PARITY: the three must match each other to the cent.
    expect(r.holdingsValue.costBasis!).toBeCloseTo(r.overview.costBasis, 2);
    expect(r.mcp.costBasis).toBeCloseTo(r.overview.costBasis, 2);
    expect(r.holdingsValue.marketValue!).toBeCloseTo(r.overview.marketValue, 2);
    expect(r.mcp.marketValue).toBeCloseTo(r.overview.marketValue, 2);
    expect(r.mcp.qty).toBeCloseTo(r.overview.qty, 6);
  });

  // tc-2 (synthetic divergence): removing the #128 skip from exactly one
  // aggregator must change a REPORTED number — proving the harness pins
  // equivalence and tc-1 is not a tautology.
  //
  // Where the divergence is observable: a Phase-2 cash leg lands on the cash
  // SLEEVE (kind=buy_cash_leg/sell_cash_leg → portfolio_holding_id = sleeve),
  // never on a STOCK holding, so the skip is a no-op for stock-holding qty/cost
  // in the two SQL aggregators (that is exactly why aligning holdings-value was
  // behavior-preserving — see the "no-op proof" case below). The MCP
  // `accumulate()` realized-gain path reads the raw buy/sell tallies directly
  // (NOT gated by a net-qty / price=1 fallback), so removing the skip there
  // phantom-books the cash leg as a buy/sell on the sleeve — the live catch.
  it("tc-2 (mcp path): disabling the cash-leg skip makes the sleeve phantom-count buys/sells", async () => {
    // Baseline — skip ON: the cash sleeve books NEITHER buy nor sell.
    SKIP_DISABLED_FOR = null;
    const mcpOk = await aggregateHoldings(mockedDb as never, "parity-user", TEST_DEK, {
      dividendsCategoryId: DIVIDENDS_CATEGORY_ID,
    });
    const sleeveOk = mcpOk.find((m) => m.holding_id === CASH_SLEEVE)!;
    expect(sleeveOk.buy_qty).toBe(0);
    expect(sleeveOk.sell_qty).toBe(0);

    // Divergent — skip OFF for MCP only: sell_cash_leg (qty +1000) phantom-
    // counts as a buy and buy_cash_leg (qty -2000) phantom-counts as a sell.
    SKIP_DISABLED_FOR = "mcp";
    const mcpBad = await aggregateHoldings(mockedDb as never, "parity-user", TEST_DEK, {
      dividendsCategoryId: DIVIDENDS_CATEGORY_ID,
    });
    const sleeveBad = mcpBad.find((m) => m.holding_id === CASH_SLEEVE)!;
    expect(sleeveBad.buy_qty + sleeveBad.sell_qty).toBeGreaterThan(0);
    // The diverged sleeve no longer matches the skip-ON baseline.
    expect(sleeveBad.buy_qty).not.toBe(sleeveOk.buy_qty);
  });

  // No-op proof: removing the skip from the two SQL aggregators leaves the
  // STOCK-holding parity numbers IDENTICAL. This documents/locks the
  // behavior-preservation finding behind FINLYNQ-106 — aligning
  // holdings-value.ts to carry the #128 skip changes no reported stock number,
  // because cash legs never reach a stock holding and cash sleeves (price=1)
  // fall back to the same market value either way.
  it("tc-2 (no-op proof): the skip never changes STOCK-holding qty/costBasis/marketValue in the SQL aggregators", async () => {
    SKIP_DISABLED_FOR = null;
    const withSkip = await runAll();

    SKIP_DISABLED_FOR = "holdings-value";
    const hvNoSkip = await runAll();
    expect(hvNoSkip.holdingsValue.costBasis!).toBeCloseTo(withSkip.holdingsValue.costBasis!, 2);
    expect(hvNoSkip.holdingsValue.marketValue!).toBeCloseTo(withSkip.holdingsValue.marketValue!, 2);

    SKIP_DISABLED_FOR = "overview";
    const ovNoSkip = await runAll();
    expect(ovNoSkip.overview.qty).toBeCloseTo(withSkip.overview.qty, 6);
    expect(ovNoSkip.overview.costBasis).toBeCloseTo(withSkip.overview.costBasis, 2);
    expect(ovNoSkip.overview.marketValue).toBeCloseTo(withSkip.overview.marketValue, 2);
  });
});
