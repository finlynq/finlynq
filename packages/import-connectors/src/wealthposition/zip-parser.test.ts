import { describe, it, expect } from "vitest";
import {
  parseWealthPositionExport,
  transformWealthPositionExport,
  type ZipContents,
} from "./zip-parser";
import { parseCsv, parseCsvDicts } from "./csv";
import type { ConnectorMappingResolved } from "../types";

// Small synthetic CSV fixtures covering every shape the real export carries.
const SYNTHETIC: ZipContents = {
  accountsCsv: `Type,Group,Account,Currency,Note
A,Banks,RBC Checking,CAD,
A,Cash Accounts,Cash CAD,CAD,
A,Investments,IBKR TFSA,CAD,
A,Investments,WealthSimple,CAD,
L,Mortgage,Mortage,CAD,
`,
  categoriesCsv: `Type,Group,Category,Note
E,Food,Groceries,
I,Salaries,Wages & salary,
E,Interest,Mortgage Interest,
R,Transfers,RRSP Contribution,
R,Transfers,Transfers,
`,
  portfolioCsv: `Portfolio account name,Portfolio holding name,Symbol,Currency,Note
IBKR TFSA,TFSA - Canada,VCN.TO,CAD,
WealthSimple,Bitcoin,,CAD,
WealthSimple,Ethereum,,CAD,
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
    expect(parsed.accounts).toHaveLength(5);
    expect(parsed.categories).toHaveLength(5);
    expect(parsed.portfolioByHolding.get("Bitcoin")?.brokerageAccount).toBe("WealthSimple");
    expect(parsed.portfolioByHolding.get("TFSA - Canada")?.symbol).toBe("VCN.TO");
    expect(parsed.transactions).toHaveLength(11);
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
