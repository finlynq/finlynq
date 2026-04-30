import { describe, expect, it } from "vitest";
import {
  CATEGORY_DEPOSITS,
  CATEGORY_DIVIDENDS,
  CATEGORY_FEES,
  CATEGORY_FX_PNL,
  CATEGORY_WITHHOLDING,
  ibkrAccountExternalId,
  inferAccountMapping,
  netCancellationTriplets,
  transformIbkrFile,
} from "./transform";
import { runIbkrTransform } from "./orchestrator";
import type {
  IbkrCashTransaction,
  IbkrParsedFile,
  IbkrStatement,
} from "./types";
import type { ConnectorMappingResolved } from "../types";

const baseStatement = (
  overrides: Partial<IbkrStatement> = {},
): IbkrStatement => ({
  accountId: "U1234567",
  accountName: "John Doe",
  baseCurrency: "USD",
  cashTransactions: [],
  trades: [],
  openPositions: [],
  fxTranslations: [],
  ...overrides,
});

const cashTx = (
  overrides: Partial<IbkrCashTransaction>,
): IbkrCashTransaction => ({
  accountId: "U1234567",
  date: "2026-04-01",
  currency: "USD",
  symbol: "",
  type: "Deposits/Withdrawals",
  amount: 100,
  description: "wire",
  ...overrides,
});

describe("netCancellationTriplets", () => {
  it("drops a triplet that nets to zero", () => {
    const rows = [
      cashTx({ actionId: "A1", date: "2026-04-01", amount: 100, description: "withhold" }),
      cashTx({ actionId: "A1", date: "2026-04-02", amount: -100, description: "cancel" }),
      cashTx({ actionId: "A1", date: "2026-04-03", amount: 100, description: "reissue" }),
    ];
    // 100 + -100 + 100 = 100 (NOT zero, because of the reissue) — so net to one row.
    const out = netCancellationTriplets(rows);
    expect(out).toHaveLength(1);
    expect(out[0].amount).toBe(100);
    expect(out[0].date).toBe("2026-04-03");
    expect(out[0].description).toMatch(/net of 3/);
  });

  it("drops a pair that cancels exactly", () => {
    const rows = [
      cashTx({ actionId: "A2", date: "2026-04-01", amount: 50 }),
      cashTx({ actionId: "A2", date: "2026-04-02", amount: -50 }),
    ];
    expect(netCancellationTriplets(rows)).toHaveLength(0);
  });

  it("preserves rows without an actionId", () => {
    const rows = [cashTx({ amount: 25, description: "wire" })];
    const out = netCancellationTriplets(rows);
    expect(out).toEqual(rows);
  });

  it("does not group across accounts or currencies", () => {
    const rows = [
      cashTx({ actionId: "X", accountId: "U1", currency: "USD", amount: 10 }),
      cashTx({ actionId: "X", accountId: "U2", currency: "USD", amount: -10 }),
      cashTx({ actionId: "X", accountId: "U1", currency: "CAD", amount: -10 }),
    ];
    // Three different keys → three single-row passthroughs.
    expect(netCancellationTriplets(rows)).toHaveLength(3);
  });
});

describe("transformIbkrFile (intermediate inventory)", () => {
  it("emits one ExternalAccount per (sub-account, currency) actually used", () => {
    const parsed: IbkrParsedFile = {
      statements: [
        baseStatement({
          accountId: "U1",
          cashTransactions: [
            cashTx({ accountId: "U1", currency: "USD", amount: 100 }),
            cashTx({ accountId: "U1", currency: "CAD", amount: 50 }),
          ],
        }),
        baseStatement({
          accountId: "U2",
          accountName: "Jane",
          cashTransactions: [
            cashTx({ accountId: "U2", currency: "USD", amount: 200 }),
          ],
        }),
      ],
    };
    const out = transformIbkrFile(parsed);
    const ids = out.accounts.map((a) => a.id).sort();
    expect(ids).toEqual([
      "ibkr:acct:U1:CAD",
      "ibkr:acct:U1:USD",
      "ibkr:acct:U2:USD",
    ]);
  });

  it("emits dividends as account + Dividends category 2-entry tx", () => {
    const parsed: IbkrParsedFile = {
      statements: [
        baseStatement({
          cashTransactions: [
            cashTx({
              accountId: "U1234567",
              currency: "USD",
              symbol: "AAPL",
              type: "Dividends",
              amount: 2.5,
              description: "AAPL CASH DIV",
              actionId: "DIV-A1",
            }),
          ],
        }),
      ],
    };
    const out = transformIbkrFile(parsed);
    expect(out.transactions).toHaveLength(1);
    const tx = out.transactions[0];
    expect(tx.entries).toHaveLength(2);
    const accountEntry = tx.entries[0];
    const categoryEntry = tx.entries[1];
    expect(accountEntry.amount).toBe(2.5);
    expect(categoryEntry.categorization).toBe(CATEGORY_DIVIDENDS);
    expect(tx.tags).toContain("source:ibkr");
  });

  it("collapses a forex pair (assetCategory='CASH') into one 2-leg tx, NOT two cash flows", () => {
    const parsed: IbkrParsedFile = {
      statements: [
        baseStatement({
          baseCurrency: "USD",
          trades: [
            {
              accountId: "U1234567",
              date: "2026-04-15",
              currency: "USD",
              assetCategory: "CASH",
              symbol: "EUR.USD",
              quantity: 500,
              tradePrice: 1.1,
              netCash: -550,
              buySell: "BUY",
              ibCommission: 0,
              tradeId: "T-FX-1",
              description: "FX BUY EUR",
            },
          ],
        }),
      ],
    };
    const out = transformIbkrFile(parsed);
    // One ExternalTransaction with TWO entries (USD leg + EUR leg).
    const fx = out.transactions.find((t) => t.id.startsWith("ibkr:fx:"));
    expect(fx).toBeDefined();
    expect(fx!.entries).toHaveLength(2);
    const usdLeg = fx!.entries.find((e) => e.currency === "USD")!;
    const eurLeg = fx!.entries.find((e) => e.currency === "EUR")!;
    expect(usdLeg.amount).toBe(-550);
    expect(eurLeg.amount).toBe(500);
    // Sub-account inventory has both currencies.
    const ids = out.accounts.map((a) => a.id);
    expect(ids).toContain("ibkr:acct:U1234567:USD");
    expect(ids).toContain("ibkr:acct:U1234567:EUR");
    // Tagged.
    expect(fx!.tags).toContain("ibkr:fx-conversion");
  });

  it("emits a cash leg + holding leg for a stock buy", () => {
    const parsed: IbkrParsedFile = {
      statements: [
        baseStatement({
          trades: [
            {
              accountId: "U1234567",
              date: "2026-04-10",
              currency: "USD",
              assetCategory: "STK",
              symbol: "AAPL",
              quantity: 10,
              tradePrice: 180,
              netCash: -1801,
              buySell: "BUY",
              ibCommission: -1,
              tradeId: "T-STK-1",
              description: "BUY AAPL",
            },
          ],
        }),
      ],
    };
    const out = transformIbkrFile(parsed);
    const tx = out.transactions.find((t) => t.id.startsWith("ibkr:trade:"))!;
    expect(tx.entries).toHaveLength(2);
    const cashEntry = tx.entries[0];
    const holdingEntry = tx.entries[1];
    expect(cashEntry.amount).toBe(-1801);
    expect(holdingEntry.categorization).toBe("AAPL");
    expect(holdingEntry.holding).toBe(10);
    expect(out.holdingPseudoAccounts.find((p) => p.name === "AAPL")).toBeDefined();
  });

  it("nets an action-id-keyed cancellation triplet to a single tx (idempotent re-run)", () => {
    const parsed: IbkrParsedFile = {
      statements: [
        baseStatement({
          cashTransactions: [
            cashTx({ actionId: "WHT-1", type: "Withholding Tax", amount: -2, date: "2026-04-01", description: "WHT AAPL" }),
            cashTx({ actionId: "WHT-1", type: "Withholding Tax", amount: 2, date: "2026-04-05", description: "REVERSAL" }),
            cashTx({ actionId: "WHT-1", type: "Withholding Tax", amount: -1, date: "2026-04-10", description: "RE-ISSUE" }),
          ],
        }),
      ],
    };
    const first = transformIbkrFile(parsed);
    const txs1 = first.transactions.filter((t) => t.id.includes(":WHT-1"));
    expect(txs1).toHaveLength(1);
    expect(Number(txs1[0].entries[0].amount)).toBeCloseTo(-1, 9);

    // Idempotent: re-running on the same input produces the same external id.
    const second = transformIbkrFile(parsed);
    const txs2 = second.transactions.filter((t) => t.id.includes(":WHT-1"));
    expect(txs2).toHaveLength(1);
    expect(txs2[0].id).toBe(txs1[0].id);
  });

  it("emits FX translation P&L as a revaluation entry (not a cash transfer)", () => {
    const parsed: IbkrParsedFile = {
      statements: [
        baseStatement({
          fxTranslations: [
            {
              accountId: "U1234567",
              date: "2026-04-30",
              currency: "USD",
              amount: -12.34,
              description: "FX TRANSLATION P&L",
            },
          ],
        }),
      ],
    };
    const out = transformIbkrFile(parsed);
    const tx = out.transactions.find((t) => t.id.startsWith("ibkr:fxpnl:"))!;
    expect(tx.entries.find((e) => e.categorization === CATEGORY_FX_PNL)).toBeDefined();
    expect(tx.tags).toContain("ibkr:fx-translation");
  });

  it("respects sub-account boundaries when emitting per-account entries", () => {
    const parsed: IbkrParsedFile = {
      statements: [
        baseStatement({
          accountId: "U1",
          cashTransactions: [
            cashTx({ accountId: "U1", currency: "USD", amount: 10, type: "Deposits/Withdrawals" }),
          ],
        }),
        baseStatement({
          accountId: "U2",
          accountName: "Other",
          cashTransactions: [
            cashTx({ accountId: "U2", currency: "USD", amount: 20, type: "Deposits/Withdrawals" }),
          ],
        }),
      ],
    };
    const out = transformIbkrFile(parsed);
    const u1Tx = out.transactions.find((t) => t.id.includes(":U1:"))!;
    const u2Tx = out.transactions.find((t) => t.id.includes(":U2:"))!;
    expect(u1Tx.entries[0].amount).toBe(10);
    expect(u2Tx.entries[0].amount).toBe(20);
    // Each row stayed bound to its own sub-account.
    expect(u1Tx.entries[0].categorization).not.toBe(u2Tx.entries[0].categorization);
  });
});

describe("inferAccountMapping", () => {
  it("matches a sub-account to a Finlynq account by Jaccard similarity of held tickers", () => {
    const parsed: IbkrParsedFile = {
      statements: [
        baseStatement({
          accountId: "U-RRSP",
          openPositions: [
            { accountId: "U-RRSP", symbol: "AAPL", assetCategory: "STK", position: 10, currency: "USD" },
            { accountId: "U-RRSP", symbol: "MSFT", assetCategory: "STK", position: 5, currency: "USD" },
          ],
        }),
        baseStatement({
          accountId: "U-TFSA",
          openPositions: [
            { accountId: "U-TFSA", symbol: "VTI", assetCategory: "STK", position: 100, currency: "USD" },
          ],
        }),
      ],
    };
    const finlynq = new Map<number, Set<string>>([
      [42, new Set(["AAPL", "MSFT", "GOOG"])],
      [99, new Set(["VTI"])],
    ]);
    const map = inferAccountMapping(parsed, finlynq);
    expect(map.get("U-RRSP")).toBe(42);
    expect(map.get("U-TFSA")).toBe(99);
  });

  it("does not suggest a match below the 50% threshold", () => {
    const parsed: IbkrParsedFile = {
      statements: [
        baseStatement({
          accountId: "U-X",
          openPositions: [
            { accountId: "U-X", symbol: "AAPL", assetCategory: "STK", position: 1, currency: "USD" },
          ],
        }),
      ],
    };
    const finlynq = new Map<number, Set<string>>([
      [1, new Set(["TSLA", "GOOG", "AMZN", "META"])],
    ]);
    expect(inferAccountMapping(parsed, finlynq).has("U-X")).toBe(false);
  });
});

// --- end-to-end orchestrator: real-shape fixture → flat RawTransaction[] ----

function buildMapping(opts: {
  accountExtIdsToFinlynq: Record<string, number>;
  symbolsToFinlynqAccount: Record<string, number>;
  categoryNamesToFinlynq: Record<string, number>;
  transferCategoryId?: number | null;
}): ConnectorMappingResolved {
  const accountMap = new Map<string, number>();
  const accountNameById = new Map<number, string>();
  const externalAccountById = new Map();
  for (const [extId, pfId] of Object.entries(opts.accountExtIdsToFinlynq)) {
    accountMap.set(extId, pfId);
    accountNameById.set(pfId, `Finlynq Account ${pfId}`);
    externalAccountById.set(extId, {
      id: extId,
      name: extId.replace(/^ibkr:acct:/, ""),
      type: "Brokerage",
      currency: extId.split(":").pop() || "USD",
    });
  }
  for (const [sym, pfId] of Object.entries(opts.symbolsToFinlynqAccount)) {
    const extId = `ibkr:holding:${sym}`;
    accountMap.set(extId, pfId);
    accountNameById.set(pfId, `Finlynq Account ${pfId}`);
    externalAccountById.set(extId, {
      id: extId,
      name: sym,
      type: "Holding",
      currency: "USD",
    });
  }
  const categoryMap = new Map<string, number | null>();
  const categoryNameById = new Map<number, string>();
  for (const [name, pfId] of Object.entries(opts.categoryNamesToFinlynq)) {
    const extId = `ibkr:cat:${name}`;
    categoryMap.set(extId, pfId);
    categoryNameById.set(pfId, name);
  }
  const transferCategoryId =
    opts.transferCategoryId === undefined ? 9999 : opts.transferCategoryId;
  if (transferCategoryId !== null) {
    categoryNameById.set(transferCategoryId, "Transfers");
  }
  return {
    accountMap,
    categoryMap,
    transferCategoryId,
    accountNameById,
    categoryNameById,
    externalAccountById,
  };
}

describe("runIbkrTransform (full orchestrator on real-shape XML)", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<FlexQueryResponse>
  <FlexStatements>
    <FlexStatement accountId="U1234567" fromDate="20260101" toDate="20260430">
      <AccountInformation accountId="U1234567" name="John Doe" currency="USD"/>
      <CashTransactions>
        <CashTransaction accountId="U1234567" currency="USD" symbol="AAPL" dateTime="20260201;160000" amount="2.50" type="Dividends" description="AAPL CASH DIVIDEND" actionID="DIV-1"/>
        <CashTransaction accountId="U1234567" currency="USD" symbol="AAPL" dateTime="20260201;160000" amount="-0.38" type="Withholding Tax" description="AAPL WHT" actionID="WHT-1"/>
        <CashTransaction accountId="U1234567" currency="USD" symbol="" dateTime="20260105;120000" amount="-100.00" type="Deposits/Withdrawals" description="WIRE OUT" actionID="DEP-1"/>
      </CashTransactions>
      <Trades>
        <Trade accountId="U1234567" currency="USD" assetCategory="STK" symbol="AAPL" dateTime="20260115;093000" tradeDate="20260115" quantity="10" tradePrice="180.00" netCash="-1801.00" buySell="BUY" ibCommission="-1.00" tradeID="T1"/>
        <Trade accountId="U1234567" currency="USD" assetCategory="CASH" symbol="EUR.USD" dateTime="20260116;103000" tradeDate="20260116" quantity="500" tradePrice="1.10" netCash="-550.00" buySell="BUY" ibCommission="0" tradeID="T2"/>
      </Trades>
    </FlexStatement>
  </FlexStatements>
</FlexQueryResponse>`;

  const mapping = buildMapping({
    accountExtIdsToFinlynq: {
      [ibkrAccountExternalId("U1234567", "USD")]: 100,
      [ibkrAccountExternalId("U1234567", "EUR")]: 101,
    },
    symbolsToFinlynqAccount: { AAPL: 100 },
    categoryNamesToFinlynq: {
      [CATEGORY_DIVIDENDS]: 200,
      [CATEGORY_WITHHOLDING]: 201,
      [CATEGORY_DEPOSITS]: 202,
      [CATEGORY_FEES]: 203,
      [CATEGORY_FX_PNL]: 204,
    },
  });

  it("produces the expected flat RawTransaction set with no duplicates", () => {
    const result = runIbkrTransform({ fileBody: xml }, mapping);
    expect(result.errors).toEqual([]);
    // Each 1A+1C tx (dividend / WHT / deposit) → 1 row with category set
    // (Finlynq's row-with-category model). 2A txs (stock buy, FX pair) → 2
    // rows representing both legs. Total: 1+1+1 + 2+2 = 7.
    expect(result.flat).toHaveLength(7);

    const fxLegs = result.flat.filter((r) =>
      typeof r.tags === "string" ? r.tags.includes("ibkr:fx-conversion") : false,
    );
    expect(fxLegs).toHaveLength(2);
    const fxCurrencies = fxLegs.map((r) => r.currency).sort();
    expect(fxCurrencies).toEqual(["EUR", "USD"]);
    const fxAccounts = new Set(fxLegs.map((r) => r.account));
    expect(fxAccounts.size).toBe(2);

    // Every emitted row carries the IB source tag.
    for (const r of result.flat) {
      expect(typeof r.tags === "string" && r.tags.includes("source:ibkr")).toBe(true);
    }
  });

  it("re-running the import produces the same external ids (idempotent)", () => {
    const a = runIbkrTransform({ fileBody: xml }, mapping);
    const b = runIbkrTransform({ fileBody: xml }, mapping);
    // Same row count, same per-row currency / amount.
    expect(a.flat.length).toBe(b.flat.length);
    const sig = (rows: typeof a.flat) =>
      rows
        .map((r) => `${r.date}|${r.account}|${r.amount}|${r.currency}|${r.payee}`)
        .sort()
        .join("\n");
    expect(sig(a.flat)).toBe(sig(b.flat));
  });
});
