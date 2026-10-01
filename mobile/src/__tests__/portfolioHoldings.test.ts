import {
  investmentAccounts,
  nonInvestmentAccounts,
  accountHoldings,
  cashSleeves,
  findCashSleeve,
  sleeveCurrencies,
  canonicalKeyOf,
  holdingDescription,
  findHoldingInOverview,
} from "../lib/portfolio/holdings";
import type { AccountBalance, PortfolioHoldingRow, EnrichedHolding } from "../../../shared/types";

function acc(p: Partial<AccountBalance> & { accountId: number }): AccountBalance {
  return {
    accountName: `Acct ${p.accountId}`,
    accountType: "A",
    accountGroup: "Investments",
    currency: "CAD",
    balance: 0,
    convertedBalance: 0,
    displayCurrency: "CAD",
    ...p,
  };
}

function hold(p: Partial<PortfolioHoldingRow> & { id: number }): PortfolioHoldingRow {
  return {
    accountId: 1,
    name: `H${p.id}`,
    symbol: null,
    currency: "USD",
    isCrypto: 0,
    isCash: false,
    note: "",
    currentShares: 0,
    accountName: "Acct",
    ...p,
  };
}

function enriched(p: Partial<EnrichedHolding>): EnrichedHolding {
  return {
    id: 1,
    accountId: 1,
    accountName: "Acct",
    name: "Name",
    symbol: null,
    currency: "USD",
    assetType: "stock",
    price: null,
    change: null,
    changePct: null,
    quoteCurrency: null,
    marketCap: null,
    image: null,
    quantity: null,
    avgCostPerShare: null,
    totalCostBasis: null,
    lifetimeCostBasis: null,
    marketValue: null,
    marketValueDisplay: null,
    unrealizedGain: null,
    unrealizedGainPct: null,
    unrealizedGainDisplay: null,
    realizedGain: null,
    dividendsReceived: null,
    totalReturn: null,
    totalReturnDisplay: null,
    totalReturnPct: null,
    firstPurchaseDate: null,
    daysHeld: null,
    pctOfPortfolio: null,
    ...p,
  };
}

const accounts: AccountBalance[] = [
  acc({ accountId: 1, isInvestment: true }),
  acc({ accountId: 2, isInvestment: false }),
  acc({ accountId: 3, isInvestment: true }),
];

const holdings: PortfolioHoldingRow[] = [
  hold({ id: 10, accountId: 1, symbol: "NVDA", currency: "USD" }),
  hold({ id: 11, accountId: 1, isCash: true, currency: "USD" }),
  hold({ id: 12, accountId: 1, isCash: true, currency: "CAD" }),
  hold({ id: 13, accountId: 3, symbol: "VFV", currency: "CAD" }),
];

describe("account selectors", () => {
  it("splits investment vs non-investment accounts", () => {
    expect(investmentAccounts(accounts).map((a) => a.accountId)).toEqual([1, 3]);
    expect(nonInvestmentAccounts(accounts).map((a) => a.accountId)).toEqual([2]);
  });
});

describe("holding selectors", () => {
  it("accountHoldings excludes cash sleeves + scopes by account", () => {
    expect(accountHoldings(holdings, 1).map((h) => h.id)).toEqual([10]);
    expect(accountHoldings(holdings, null)).toEqual([]);
  });

  it("cashSleeves returns only is_cash rows for the account", () => {
    expect(cashSleeves(holdings, 1).map((h) => h.id)).toEqual([11, 12]);
  });

  it("findCashSleeve matches currency case-insensitively", () => {
    expect(findCashSleeve(holdings, 1, "usd")?.id).toBe(11);
    expect(findCashSleeve(holdings, 1, "EUR")).toBeNull();
    expect(findCashSleeve(holdings, 99, "USD")).toBeNull();
  });

  it("sleeveCurrencies returns distinct sorted currencies", () => {
    expect(sleeveCurrencies(holdings, 1)).toEqual(["CAD", "USD"]);
    expect(sleeveCurrencies(holdings, 3)).toEqual([]);
  });
});

describe("canonicalKeyOf", () => {
  it("keys equities by uppercased symbol", () => {
    expect(canonicalKeyOf(enriched({ assetType: "stock", symbol: "nvda" }))).toBe("eq:NVDA");
    expect(canonicalKeyOf(enriched({ assetType: "etf", symbol: "vfv" }))).toBe("eq:VFV");
  });
  it("keys crypto distinctly", () => {
    expect(canonicalKeyOf(enriched({ assetType: "crypto", symbol: "btc" }))).toBe("crypto:BTC");
  });
  it("keys cash by symbol/currency, metals separately", () => {
    expect(canonicalKeyOf(enriched({ assetType: "cash", symbol: "USD" }))).toBe("cash:USD");
    expect(canonicalKeyOf(enriched({ assetType: "cash", symbol: null, currency: "cad" }))).toBe("cash:CAD");
    expect(canonicalKeyOf(enriched({ assetType: "cash", symbol: "XAU" }))).toBe("metal:XAU");
  });
  it("falls back to a lowercased name key", () => {
    expect(canonicalKeyOf(enriched({ assetType: "stock", symbol: null, name: "My Thing" }))).toBe(
      "custom:my thing"
    );
  });
  it("keys the server's 'metal' assetType like canonical.ts (metal:<SYM>)", () => {
    // The overview route reports XAU/XAG/XPT/XPD as assetType "metal" and
    // clusters them as `metal:<SYM>` — they must not fall through to custom:.
    expect(canonicalKeyOf(enriched({ assetType: "metal", symbol: "xau", name: "Gold" }))).toBe("metal:XAU");
    expect(canonicalKeyOf(enriched({ assetType: "metal", symbol: "XPD" }))).toBe("metal:XPD");
    // Defensive: a symbol-less metal row clusters by currency (server feeds "cash").
    expect(canonicalKeyOf(enriched({ assetType: "metal", symbol: null, currency: "usd" }))).toBe("cash:USD");
  });
  it("keys an empty custom name as '?' (server uses name || '?')", () => {
    expect(canonicalKeyOf(enriched({ assetType: "stock", symbol: null, name: "" }))).toBe("custom:?");
    expect(canonicalKeyOf(enriched({ assetType: "stock", symbol: null, name: null }))).toBe("custom:?");
  });
});

describe("findHoldingInOverview", () => {
  const summary = (key: string, qty: number) => ({
    key,
    symbol: null,
    name: key,
    assetType: "stock",
    totalQty: qty,
    avgCostDisplay: null,
    costBasisDisplay: 0,
    marketValueDisplay: 0,
    unrealizedGainDisplay: 0,
    unrealizedGainPct: null,
    realizedGainDisplay: 0,
    dividendsDisplay: 0,
    totalReturnDisplay: 0,
    totalReturnPct: null,
    pctOfPortfolio: null,
    accountCount: 1,
  });
  const overview = {
    byHolding: [summary("eq:NVDA", 10), summary("metal:XAU", 2), summary("eq:NVDA", 3)],
    holdings: [
      enriched({ id: 1, assetType: "stock", symbol: "NVDA", accountId: 1 }),
      enriched({ id: 2, assetType: "metal", symbol: "XAU", accountId: 1 }),
      enriched({ id: 3, assetType: "stock", symbol: "nvda", accountId: 2 }),
    ],
  };

  it("returns the first matching row plus every member position", () => {
    const found = findHoldingInOverview(overview, "eq:NVDA");
    expect(found?.summary.totalQty).toBe(10);
    expect(found?.members.map((m) => m.id)).toEqual([1, 3]);
  });
  it("recovers metal members", () => {
    expect(findHoldingInOverview(overview, "metal:XAU")?.members.map((m) => m.id)).toEqual([2]);
  });
  it("returns null when the key is gone", () => {
    expect(findHoldingInOverview(overview, "eq:AAPL")).toBeNull();
  });
});

describe("holdingDescription (FINLYNQ-242)", () => {
  it("prefers the quote/description over the stored name", () => {
    expect(
      holdingDescription({ description: "Apple Inc.", name: "AAPL", symbol: "AAPL" })
    ).toBe("Apple Inc.");
  });
  it("falls back to the stored name when no description is present", () => {
    expect(holdingDescription({ description: null, name: "Apple Inc.", symbol: "AAPL" })).toBe(
      "Apple Inc."
    );
  });
  it("returns null when the only candidate just echoes the ticker (equity cold cache)", () => {
    // Warm price_cache hit: quoteName === symbol AND stored name === symbol.
    expect(holdingDescription({ description: null, name: "AAPL", symbol: "AAPL" })).toBeNull();
    // Case-insensitive echo is also dropped.
    expect(holdingDescription({ description: "aapl", name: "aapl", symbol: "AAPL" })).toBeNull();
  });
  it("returns null for cash sleeves (no distinct description vs the Cash <CCY> name)", () => {
    // Cash sleeve: byHolding name is "Cash USD", symbol "USD" — but no quote
    // description, and "Cash USD" !== "USD" so it would surface; the screen
    // keeps the ticker/name primary because description is null on the payload.
    expect(holdingDescription({ description: null, name: null, symbol: "USD" })).toBeNull();
  });
  it("returns null for metals / empty inputs without throwing (cold-DEK defense)", () => {
    expect(holdingDescription({ description: null, name: null, symbol: "XAU" })).toBeNull();
    expect(holdingDescription({})).toBeNull();
    expect(holdingDescription({ description: "  ", name: "  ", symbol: null })).toBeNull();
  });
});
