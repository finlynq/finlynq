import { describe, it, expect } from "vitest";
import {
  parseWealthPositionExport,
  transformWealthPositionExport,
  type ZipContents,
} from "./zip-parser";
import { parseCsv, parseCsvDicts } from "./csv";
import type { ConnectorMappingResolved } from "../types";

// Small synthetic CSV fixtures covering every shape the real export carries.
// IBKR Joint, Joint - USD, and Joint - CAD are "dual-nature" — they appear
// in BOTH Accounts.csv and Portfolio.csv (they're top-level accounts AND
// currency-sleeved holdings of the brokerage). This mirrors how a real WP
// export looks and exercises the transform's holding-name tagging for same-
// account conversions + liquidations.
const SYNTHETIC: ZipContents = {
  accountsCsv: `Type,Group,Account,Currency,Note
A,Banks,RBC Checking,CAD,
A,Cash Accounts,Cash CAD,CAD,
A,Investments,IBKR TFSA,CAD,
A,Investments,WealthSimple,CAD,
A,Investments,IBKR Joint,CAD,
A,Investments,Joint - USD,USD,
A,Investments,Joint - CAD,CAD,
L,Mortgage,Mortage,CAD,
`,
  categoriesCsv: `Type,Group,Category,Note
E,Food,Groceries,
I,Salaries,Wages & salary,
E,Interest,Mortgage Interest,
R,Transfers,RRSP Contribution,
R,Transfers,Transfers,
I,Investment Returns,Dividends,
`,
  portfolioCsv: `Portfolio account name,Portfolio holding name,Symbol,Currency,Note
IBKR TFSA,TFSA - Canada,VCN.TO,CAD,
WealthSimple,Bitcoin,,CAD,
WealthSimple,Ethereum,,CAD,
IBKR Joint,Joint - USD,,USD,
IBKR Joint,Joint - CAD,,CAD,
IBKR Joint,Joint - Dev Asia ex Japan - A,VDEA.TO,USD,
IBKR Joint,Joint - All W - D,VWRD.L,USD,
`,
  transactionsCsv: `Date,Account,Categorization,Currency,Amount,Quantity,Portfolio holding,Note,Payee,Tags
2026-03-08,Cash CAD,Groceries,CAD,-100.00,,,walmart,,
2026-03-08,Mortage,Mortgage Interest,CAD,-678.13,,,,,
2026-03-05,RBC Checking,#SPLIT#,CAD,3000.00,,,Payroll,,
2026-03-05,#SPLIT#,Wages & salary,CAD,3500.00,,,,,
2026-03-05,#SPLIT#,RRSP Contribution,CAD,-500.00,,,,,
2026-02-14,RBC Checking,#SPLIT#,USD,-1000.00,,,Wire Out,,
2026-02-14,#SPLIT#,IBKR TFSA,USD,1000.00,,,Wire In,,
2026-02-01,IBKR TFSA,#SPLIT#,CAD,-800.00,,,Stock buy,,
2026-02-01,#SPLIT#,TFSA - Canada,CAD,800.00,12.0000,,,,
2026-01-15,WealthSimple,#SPLIT#,CAD,-50.00,,,Buy BTC,,
2026-01-15,#SPLIT#,Bitcoin,CAD,50.00,0.000311,,,,
2025-08-11,Joint - USD,#SPLIT#,CAD,-52414.16,-38000,Joint - CAD,,,
2025-08-11,#SPLIT#,Joint - CAD,CAD,52414.16,52414.16,Joint - CAD,,,
2025-07-31,Joint - Dev Asia ex Japan - A,#SPLIT#,USD,-1420.4,-40,Joint - USD,,,
2025-07-31,#SPLIT#,Joint - USD,CAD,1960,1420.4,Joint - USD,,,
2024-12-31,Joint - USD,Dividends,CAD,20,14.29,Joint - All W - D,,,
`,
};

function buildResolvedMapping(parsed: ReturnType<typeof parseWealthPositionExport>, transferCatId: number | null = 1000): ConnectorMappingResolved {
  const accountMap = new Map<string, number>();
  const accountNameById = new Map<number, string>();
  parsed.accounts.forEach((a, i) => {
    const pfId = 100 + i;
    accountMap.set(a.id, pfId);
    accountNameById.set(pfId, a.name); // name-parity with the CSV
  });
  const categoryMap = new Map<string, number | null>();
  const categoryNameById = new Map<number, string>();
  parsed.categories.forEach((c, i) => {
    const pfId = 200 + i;
    categoryMap.set(c.id, pfId);
    categoryNameById.set(pfId, c.name);
  });
  const externalAccountById = new Map(parsed.accounts.map((a) => [a.id, a] as const));
  if (transferCatId !== null) categoryNameById.set(transferCatId, "Transfers");
  return {
    accountMap,
    categoryMap,
    transferCategoryId: transferCatId,
    accountNameById,
    categoryNameById,
    externalAccountById,
  };
}

describe("csv parser", () => {
  it("splits simple rows", () => {
    expect(parseCsv("a,b,c\n1,2,3\n")).toEqual([["a","b","c"],["1","2","3"]]);
  });
  it("handles quoted fields with commas", () => {
    expect(parseCsv(`a,b\n"UBER, CANADA","note"`)).toEqual([["a","b"],["UBER, CANADA","note"]]);
  });
  it("handles escaped quotes inside quoted fields", () => {
    expect(parseCsv(`a\n"hello ""world"""`)).toEqual([["a"],[`hello "world"`]]);
  });
  it("parseCsvDicts keys by header", () => {
    expect(parseCsvDicts("Date,Amount\n2026-01-01,100")).toEqual([{ Date: "2026-01-01", Amount: "100" }]);
  });
});

describe("parseWealthPositionExport", () => {
  it("parses accounts / categories / portfolio / transactions", () => {
    const parsed = parseWealthPositionExport(SYNTHETIC);
    expect(parsed.accounts).toHaveLength(8);
    expect(parsed.categories).toHaveLength(6);
    expect(parsed.portfolioByHolding.get("Bitcoin")?.brokerageAccount).toBe("WealthSimple");
    expect(parsed.portfolioByHolding.get("TFSA - Canada")?.symbol).toBe("VCN.TO");
    expect(parsed.transactions).toHaveLength(16);
  });
});

describe("transformWealthPositionExport", () => {
  it("emits a direct 1A+1C row as a single flat tx", () => {
    const parsed = parseWealthPositionExport(SYNTHETIC);
    const mapping = buildResolvedMapping(parsed);
    const r = transformWealthPositionExport(parsed, mapping);
    const grocery = r.flat.find((t) => t.category === "Groceries");
    expect(grocery).toBeDefined();
    expect(grocery).toMatchObject({ account: "Cash CAD", amount: -100, payee: "" });
  });

  it("emits category-split paycheck as parent + N split rows", () => {
    const parsed = parseWealthPositionExport(SYNTHETIC);
    const mapping = buildResolvedMapping(parsed);
    const r = transformWealthPositionExport(parsed, mapping);
    const paycheckSplit = r.splits.find((s) => s.parent.date === "2026-03-05");
    expect(paycheckSplit).toBeDefined();
    expect(paycheckSplit!.parent.account).toBe("RBC Checking");
    expect(paycheckSplit!.parent.amount).toBe(3000);
    expect(paycheckSplit!.splits).toHaveLength(2);
    const wages = paycheckSplit!.splits.find((s) => s.amount === 3500);
    const rrsp = paycheckSplit!.splits.find((s) => s.amount === -500);
    expect(wages).toBeDefined();
    expect(rrsp).toBeDefined();
  });

  it("emits account-to-account transfer as two flat txs with Transfer category", () => {
    const parsed = parseWealthPositionExport(SYNTHETIC);
    const mapping = buildResolvedMapping(parsed);
    const r = transformWealthPositionExport(parsed, mapping);
    const transferTxs = r.flat.filter((t) => t.date === "2026-02-14");
    expect(transferTxs).toHaveLength(2);
    expect(transferTxs.every((t) => t.category === "Transfers")).toBe(true);
    const out = transferTxs.find((t) => t.account === "RBC Checking");
    const inn = transferTxs.find((t) => t.account === "IBKR TFSA");
    expect(out?.amount).toBe(-1000);
    expect(inn?.amount).toBe(1000);
  });

  it("routes a stock purchase: cash leg on cash account + holding leg on brokerage", () => {
    const parsed = parseWealthPositionExport(SYNTHETIC);
    const mapping = buildResolvedMapping(parsed);
    const r = transformWealthPositionExport(parsed, mapping);
    const stockTxs = r.flat.filter((t) => t.date === "2026-02-01");
    // Expect 2 legs: cash parent on IBKR TFSA (parent was on that account
    // in SYNTHETIC) and one holding leg on IBKR TFSA.
    expect(stockTxs.length).toBe(2);
    // Parent cash leg — amount preserved (WP convention: position purchase
    // from this cash account is -800 = cash out).
    const cashLeg = stockTxs.find((t) => !t.portfolioHolding);
    expect(cashLeg).toBeDefined();
    expect(cashLeg!.amount).toBe(-800);
    // Holding leg — routed via Portfolio.csv to the brokerage that owns
    // the holding, carries the holding NAME (not symbol) on the tx so the
    // aggregator can match portfolio_holdings.name.
    const holdingLeg = stockTxs.find((t) => t.portfolioHolding === "TFSA - Canada");
    expect(holdingLeg).toBeDefined();
    expect(holdingLeg!.account).toBe("IBKR TFSA");
    expect(holdingLeg!.quantity).toBe(12);
    expect(holdingLeg!.amount).toBe(800);
  });

  it("routes crypto purchase (Bitcoin) via Portfolio.csv to WealthSimple", () => {
    const parsed = parseWealthPositionExport(SYNTHETIC);
    const mapping = buildResolvedMapping(parsed);
    const r = transformWealthPositionExport(parsed, mapping);
    const btcLeg = r.flat.find((t) => t.portfolioHolding === "Bitcoin");
    expect(btcLeg).toBeDefined();
    expect(btcLeg!.account).toBe("WealthSimple"); // brokerage, not "Bitcoin"
    expect(btcLeg!.quantity).toBeCloseTo(0.000311, 9);
  });

  it("errors when an account isn't mapped", () => {
    const parsed = parseWealthPositionExport(SYNTHETIC);
    const mapping = buildResolvedMapping(parsed);
    // Remove the RBC Checking mapping
    const rbcExtId = parsed.accounts.find((a) => a.name === "RBC Checking")!.id;
    mapping.accountMap.delete(rbcExtId);
    const r = transformWealthPositionExport(parsed, mapping);
    expect(r.errors.some((e) => e.reason.includes("RBC Checking"))).toBe(true);
  });

  it("shares one linkId across every leg of a transfer set", () => {
    const parsed = parseWealthPositionExport(SYNTHETIC);
    const mapping = buildResolvedMapping(parsed);
    const r = transformWealthPositionExport(parsed, mapping);
    const transferTxs = r.flat.filter((t) => t.date === "2026-02-14");
    expect(transferTxs).toHaveLength(2);
    const linkIds = new Set(transferTxs.map((t) => t.linkId));
    expect(linkIds.size).toBe(1);
    expect([...linkIds][0]).toBeTruthy();
  });

  it("shares one linkId across a stock-buy cash leg + position leg", () => {
    const parsed = parseWealthPositionExport(SYNTHETIC);
    const mapping = buildResolvedMapping(parsed);
    const r = transformWealthPositionExport(parsed, mapping);
    const stockTxs = r.flat.filter((t) => t.date === "2026-02-01");
    const linkIds = new Set(stockTxs.map((t) => t.linkId));
    expect(linkIds.size).toBe(1);
  });

  it("emits a same-account holding conversion with both legs categorized as Transfer (Case 2)", () => {
    // Aug 11 USD→CAD conversion inside IBKR Joint:
    //   Joint - USD (holding), qty -38000, amt -52414.16 → parent
    //   Joint - CAD (holding), qty +52414.16, amt +52414.16 → child
    // Both legs should be on IBKR Joint in Finlynq, both with Transfer
    // category, each tagged with its own portfolio_holding so the
    // aggregator sees the qty movements on both sides.
    const parsed = parseWealthPositionExport(SYNTHETIC);
    const mapping = buildResolvedMapping(parsed);
    const r = transformWealthPositionExport(parsed, mapping);
    const conversionTxs = r.flat.filter((t) => t.date === "2025-08-11");
    expect(conversionTxs).toHaveLength(2);
    // Both sides use the Transfer category (parent was silently null before).
    expect(conversionTxs.every((t) => t.category === "Transfers")).toBe(true);
    // Portfolio holdings match the parent/child account, not the CSV's
    // Portfolio-holding column (which points at the destination, not the
    // source).
    const usdLeg = conversionTxs.find((t) => t.portfolioHolding === "Joint - USD");
    const cadLeg = conversionTxs.find((t) => t.portfolioHolding === "Joint - CAD");
    expect(usdLeg).toBeDefined();
    expect(cadLeg).toBeDefined();
    expect(usdLeg!.amount).toBe(-52414.16);
    expect(usdLeg!.quantity).toBe(-38000);
    expect(cadLeg!.amount).toBe(52414.16);
    expect(cadLeg!.quantity).toBe(52414.16);
    // Shared linkId so the UI can surface them as siblings.
    expect(usdLeg!.linkId).toBeTruthy();
    expect(usdLeg!.linkId).toBe(cadLeg!.linkId);
  });

  it("emits a stock liquidation with the sell leg preserving qty<0 on the position (Case 3)", () => {
    // Jul 31 liquidation: -40 shares of "Joint - Dev Asia ex Japan - A"
    // for $1420.4 USD into Joint - USD cash. The position leg MUST carry
    // portfolio_holding="Joint - Dev Asia ex Japan - A" + quantity=-40
    // so the portfolio aggregator sees the sell. Before the fix it was
    // dropped because parentHoldingRef was set but the branch skipped the
    // parent entirely.
    const parsed = parseWealthPositionExport(SYNTHETIC);
    const mapping = buildResolvedMapping(parsed);
    const r = transformWealthPositionExport(parsed, mapping);
    const liquidationTxs = r.flat.filter((t) => t.date === "2025-07-31");
    // 2 txs: sell leg on the position + cash leg on Joint - USD.
    expect(liquidationTxs).toHaveLength(2);
    const sellLeg = liquidationTxs.find((t) => t.portfolioHolding === "Joint - Dev Asia ex Japan - A");
    expect(sellLeg).toBeDefined();
    expect(sellLeg!.amount).toBe(-1420.4);
    expect(sellLeg!.quantity).toBe(-40);
    expect(sellLeg!.category).toBe("Transfers");
    const cashLeg = liquidationTxs.find((t) => t.portfolioHolding === "Joint - USD");
    expect(cashLeg).toBeDefined();
    expect(cashLeg!.amount).toBe(1960);
    expect(cashLeg!.quantity).toBe(1420.4);
    expect(cashLeg!.category).toBe("Transfers");
    // Linked.
    expect(sellLeg!.linkId).toBeTruthy();
    expect(sellLeg!.linkId).toBe(cashLeg!.linkId);
  });

  it("records a dividend with a source-holding tag, without moving shares", () => {
    // CSV row: `Joint - USD, Dividends, CAD, 20, 14.29, Joint - All W - D`
    // WP semantics: Joint - USD received $20 cash (+14.29 USD qty on the
    // cash sleeve) as a dividend from Joint - All W - D. NO share movement
    // on Joint - All W - D — its qty stays exactly the same. The source
    // holding is a reporting tag, preserved in `tags` as `source:...`.
    const parsed = parseWealthPositionExport(SYNTHETIC);
    const mapping = buildResolvedMapping(parsed);
    const r = transformWealthPositionExport(parsed, mapping);
    const divTxs = r.flat.filter((t) => t.date === "2024-12-31");
    expect(divTxs).toHaveLength(1);
    const div = divTxs[0];
    // Landed on the source holding (Joint - USD), NOT the tagged holding.
    expect(div.portfolioHolding).toBe("Joint - USD");
    expect(div.amount).toBe(20);
    expect(div.quantity).toBe(14.29);
    expect(div.category).toBe("Dividends");
    // Source-holding preserved as a tag.
    expect(div.tags).toBe("source:Joint - All W - D");
  });

  it("rejects orphan #SPLIT# rows that have no preceding parent", () => {
    const parsed = parseWealthPositionExport({
      ...SYNTHETIC,
      transactionsCsv: `Date,Account,Categorization,Currency,Amount,Quantity,Portfolio holding,Note,Payee,Tags
2026-03-05,#SPLIT#,Wages & salary,CAD,500,,,orphan,,
`,
    });
    const mapping = buildResolvedMapping(parsed);
    const r = transformWealthPositionExport(parsed, mapping);
    expect(r.errors.length).toBe(1);
    expect(r.errors[0].reason).toMatch(/Orphan/);
  });
});
