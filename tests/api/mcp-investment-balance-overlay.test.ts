/**
 * FINLYNQ-151 — MCP balance tools value investment accounts at MARKET, not
 * ledger (net contributions).
 *
 * Two layers:
 *  1. Pure overlay unit tests (`applyInvestmentMarketOverlay`) with an injected
 *     `fetchHoldings` spy — no DB, no mocking. Cover: market path; dek-null →
 *     ledger + note + fetch-never-called; missing-from-map investment → 0;
 *     no-investment-rows → fetch-never-called.
 *  2. Handler tests against a fake `DbLike` (mcp-http-smoke conventions) with
 *     `getHoldingsValueByAccount` + the FX `getRate` mocked. Cover: market
 *     value lands in the tagged fields + `cashFlowBasis`; the PARITY contract
 *     (`get_net_worth.total.net.amount === get_account_balances.totalReporting
 *     .amount`) holds dek-present AND dek-null; dek-null is byte-compatible
 *     with the v3.2 ledger numbers and carries the explanatory note.
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
import { randomBytes } from "node:crypto";

// Stable env so the auth/encryption modules don't blow up at import time
// (mirrors mcp-http-smoke.test.ts).
process.env.PF_JWT_SECRET = "test-jwt-secret-for-vitest-32chars!!";
process.env.PF_PEPPER = process.env.PF_PEPPER ?? "test-pepper-32chars-for-vitest-only!!";
process.env.PF_STAGING_KEY = process.env.PF_STAGING_KEY ?? "test-staging-key-32chars-for-vitest!";

// Mock the holdings-value pricing path so handler tests are deterministic and
// the qty×1 hazard never executes. The overlay's dek-null guard means this is
// only consulted on the dek-present pass.
const holdingsMap = new Map<number, { value: number; costBasis: number }>();
// FINLYNQ-281 — the handlers now also call verifyHoldingDecryptHealth via the
// overlay's `verifyDecrypt` probe; default to healthy so the market path (and
// every pre-existing handler assertion) is unchanged.
vi.mock("../../src/lib/holdings-value", () => ({
  getHoldingsValueByAccount: vi.fn(async () => holdingsMap),
  verifyHoldingDecryptHealth: vi.fn(async () => ({ failed: 0, total: 0 })),
}));

// Mock FX so reporting conversion is the identity (every rate = 1). Lets the
// parity assertion compare raw numbers without a live FX dependency. We only
// stub the symbols register-tools-pg imports from fx-service; everything else
// is irrelevant to these two handlers.
vi.mock("../../src/lib/fx-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/fx-service")>();
  return { ...actual, getRate: vi.fn(async () => 1) };
});

import { applyInvestmentMarketOverlay } from "../../src/lib/accounts/investment-balance-overlay";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPgTools } from "../../mcp-server/register-tools-pg";

// ──────────────────────────────────────────────────────────────────────────
// 1. Pure overlay unit tests
// ──────────────────────────────────────────────────────────────────────────
describe("applyInvestmentMarketOverlay (pure)", () => {
  const dek = randomBytes(32);

  it("market path: investment rows take holdings.value + costBasis; non-investment unchanged", async () => {
    const fetchHoldings = vi.fn(async () =>
      new Map([[2, { value: 15000, costBasis: 9000 }]]),
    );
    const res = await applyInvestmentMarketOverlay(
      [
        { id: 1, currency: "USD", isInvestment: false, ledgerBalance: 500 },
        { id: 2, currency: "USD", isInvestment: true, ledgerBalance: 0 },
      ],
      dek,
      fetchHoldings,
    );
    expect(fetchHoldings).toHaveBeenCalledTimes(1);
    expect(res.marketApplied).toBe(true);
    expect(res.note).toBeUndefined();
    // Non-investment row: ledger, no costBasis.
    expect(res.rows[0]).toMatchObject({ id: 1, balance: 500, balanceBasis: "ledger" });
    expect(res.rows[0].costBasis).toBeUndefined();
    // Investment row: market value, costBasis from the map.
    expect(res.rows[1]).toMatchObject({ id: 2, balance: 15000, balanceBasis: "market", costBasis: 9000 });
  });

  it("dek-null with investment rows: ledger + note + fetch NEVER called", async () => {
    const fetchHoldings = vi.fn(async () => new Map());
    const res = await applyInvestmentMarketOverlay(
      [
        { id: 1, currency: "USD", isInvestment: false, ledgerBalance: 500 },
        { id: 2, currency: "USD", isInvestment: true, ledgerBalance: 1234.56 },
      ],
      null,
      fetchHoldings,
    );
    expect(fetchHoldings).not.toHaveBeenCalled();
    expect(res.marketApplied).toBe(false);
    expect(res.note).toBeTruthy();
    // Investment row keeps its ledger (net-contribution) balance, basis ledger.
    expect(res.rows[1]).toMatchObject({ id: 2, balance: 1234.56, balanceBasis: "ledger" });
    expect(res.rows[1].costBasis).toBeUndefined();
  });

  it("missing-from-map investment account → 0 (issue #204), not the tx-sum", async () => {
    const fetchHoldings = vi.fn(async () => new Map()); // priced nothing
    const res = await applyInvestmentMarketOverlay(
      [{ id: 9, currency: "CAD", isInvestment: true, ledgerBalance: 7777 }],
      dek,
      fetchHoldings,
    );
    expect(fetchHoldings).toHaveBeenCalledTimes(1);
    expect(res.rows[0]).toMatchObject({ id: 9, balance: 0, balanceBasis: "market", costBasis: 0 });
  });

  it("no investment rows: fetch NEVER called, no note, all ledger", async () => {
    const fetchHoldings = vi.fn(async () => new Map());
    const res = await applyInvestmentMarketOverlay(
      [{ id: 1, currency: "USD", isInvestment: false, ledgerBalance: 42 }],
      dek,
      fetchHoldings,
    );
    expect(fetchHoldings).not.toHaveBeenCalled();
    expect(res.marketApplied).toBe(false);
    expect(res.note).toBeUndefined();
    expect(res.rows[0]).toMatchObject({ balance: 42, balanceBasis: "ledger" });
  });

  // FINLYNQ-281 — a present-but-invalid DEK (stale MCP session cache after the
  // demo DEK rotation, or a corrupt ciphertext row) must NOT produce a garbage
  // `basis:"market"` total. The probe reports failures → fall back to ledger +
  // note, and NEVER call the qty×1 pricing path.
  it("decrypt failure (dek present): ledger + note + decryptionFailed, fetch NEVER called", async () => {
    const fetchHoldings = vi.fn(async () => new Map([[2, { value: 15000, costBasis: 9000 }]]));
    const verifyDecrypt = vi.fn(async () => ({ failed: 1, total: 3 }));
    const res = await applyInvestmentMarketOverlay(
      [
        { id: 1, currency: "USD", isInvestment: false, ledgerBalance: 500 },
        { id: 2, currency: "USD", isInvestment: true, ledgerBalance: 1234.56 },
      ],
      dek,
      fetchHoldings,
      verifyDecrypt,
    );
    expect(verifyDecrypt).toHaveBeenCalledTimes(1);
    expect(fetchHoldings).not.toHaveBeenCalled(); // qty×1 garbage path skipped
    expect(res.marketApplied).toBe(false);
    expect(res.decryptionFailed).toBe(true);
    expect(res.note).toBeTruthy();
    // Investment row falls back to its ledger (net-contribution) balance.
    expect(res.rows[1]).toMatchObject({ id: 2, balance: 1234.56, balanceBasis: "ledger" });
    expect(res.rows[1].costBasis).toBeUndefined();
  });

  it("healthy decrypt (failed:0): market path proceeds unchanged", async () => {
    const fetchHoldings = vi.fn(async () => new Map([[2, { value: 15000, costBasis: 9000 }]]));
    const verifyDecrypt = vi.fn(async () => ({ failed: 0, total: 3 }));
    const res = await applyInvestmentMarketOverlay(
      [{ id: 2, currency: "USD", isInvestment: true, ledgerBalance: 0 }],
      dek,
      fetchHoldings,
      verifyDecrypt,
    );
    expect(verifyDecrypt).toHaveBeenCalledTimes(1);
    expect(fetchHoldings).toHaveBeenCalledTimes(1);
    expect(res.marketApplied).toBe(true);
    expect(res.decryptionFailed).toBeUndefined();
    expect(res.rows[0]).toMatchObject({ id: 2, balance: 15000, balanceBasis: "market", costBasis: 9000 });
  });

  it("decrypt probe is skipped when omitted (back-compat 3-arg call still market)", async () => {
    const fetchHoldings = vi.fn(async () => new Map([[2, { value: 15000, costBasis: 9000 }]]));
    const res = await applyInvestmentMarketOverlay(
      [{ id: 2, currency: "USD", isInvestment: true, ledgerBalance: 0 }],
      dek,
      fetchHoldings,
    );
    expect(fetchHoldings).toHaveBeenCalledTimes(1);
    expect(res.marketApplied).toBe(true);
    expect(res.decryptionFailed).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 2. Handler tests — fake DbLike returning a fixed account set
// ──────────────────────────────────────────────────────────────────────────

// Two accounts: a USD bank (id 1, type A, ledger 500) and a USD brokerage
// (id 2, type A, is_investment, ledger 0 net contributions but market 15000).
// `balance` is the alias get_account_balances selects; `total` is the alias
// get_net_worth's per-account query selects — provide both so the one fixture
// serves both handlers.
const ACCOUNT_ROWS = [
  { id: 1, name_ct: null, alias_ct: null, type: "A", group: "Banks", currency: "USD", is_investment: false, balance: 500, total: 500 },
  { id: 2, name_ct: null, alias_ct: null, type: "A", group: "Investments", currency: "USD", is_investment: true, balance: 0, total: 0 },
];

/** A DbLike that serves the per-account balance query for both tools and an
 * empty rowset for everything else (settings lookup → default reporting). */
function makeFakeDb() {
  return {
    execute: async (q: unknown) => {
      const text = serialize(q);
      // Both get_account_balances and get_net_worth current-totals select
      // `a.is_investment` + `COALESCE(SUM(t.amount)` from `accounts a`.
      if (/FROM\s+accounts\s+a\b/i.test(text) && /a\.is_investment/i.test(text)) {
        return { rows: ACCOUNT_ROWS, rowCount: ACCOUNT_ROWS.length };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

function serialize(q: unknown): string {
  if (!q || typeof q !== "object") return String(q);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sqlObj = q as any;
  try {
    const dialect = { escapeName: (n: string) => `"${n}"`, escapeParam: () => "?" };
    const r = sqlObj.toQuery?.(dialect);
    if (r && typeof r.sql === "string") return r.sql;
  } catch {
    /* fall through */
  }
  const chunks = sqlObj.queryChunks ?? sqlObj.chunks ?? [];
  let out = "";
  for (const c of chunks) {
    if (c && typeof c === "object" && Array.isArray((c as { value?: unknown[] }).value)) {
      out += (c as { value: string[] }).value.join("");
    } else if (typeof c === "string") {
      out += c;
    }
  }
  return out;
}

function bootstrap(dek: Buffer | null) {
  const db = makeFakeDb();
  const server = new McpServer({ name: "overlay-test", version: "0.0.0" });
  registerPgTools(server, db, "default", dek);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools = (server as any)._registeredTools as Record<string, { handler: (a: unknown, e: unknown) => Promise<unknown> }>;
  return { tools };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parse(res: any): any {
  return JSON.parse(res.content[0].text).data;
}

describe("get_account_balances + get_net_worth — investment market overlay (handlers)", () => {
  beforeAll(() => {
    holdingsMap.clear();
    holdingsMap.set(2, { value: 15000, costBasis: 9000 });
  });

  it("DEK present: investment account is market-valued with tagged fields + cashFlowBasis", async () => {
    const { tools } = bootstrap(randomBytes(32));
    const data = parse(await tools["get_account_balances"].handler({ reportingCurrency: "USD" }, {}));
    const invest = data.accounts.find((a: { id: number }) => a.id === 2);
    expect(invest.isInvestment).toBe(true);
    expect(invest.balanceBasis).toBe("market");
    expect(invest.balance).toBe(15000);
    expect(invest.balanceTagged).toMatchObject({ amount: 15000, currency: "USD", type: "account" });
    expect(invest.costBasis).toMatchObject({ amount: 9000, currency: "USD" });
    // cashFlowBasis carries the underlying net-contribution tx-sum (0 here).
    expect(invest.cashFlowBasis).toMatchObject({ amount: 0, currency: "USD" });
    // Bank account stays ledger.
    const bank = data.accounts.find((a: { id: number }) => a.id === 1);
    expect(bank.balanceBasis).toBe("ledger");
    expect(bank.balance).toBe(500);
    expect(bank.cashFlowBasis).toBeUndefined();
    // No dek-null note when the overlay applied.
    expect(data.note).toBeUndefined();
  });

  it("PARITY (DEK present): get_net_worth.total.net.amount === get_account_balances.totalReporting.amount", async () => {
    const { tools } = bootstrap(randomBytes(32));
    const bal = parse(await tools["get_account_balances"].handler({ reportingCurrency: "USD" }, {}));
    const nw = parse(await tools["get_net_worth"].handler({ reportingCurrency: "USD" }, {}));
    expect(nw.basis).toBe("market");
    // 500 (bank) + 15000 (brokerage market) = 15500.
    expect(bal.totalReporting.amount).toBe(15500);
    expect(nw.total.net.amount).toBe(15500);
    expect(nw.total.net.amount).toBe(bal.totalReporting.amount);
  });

  it("DEK null: byte-compatible ledger numbers + note; investment account stays at net-contribution", async () => {
    const { tools } = bootstrap(null);
    const data = parse(await tools["get_account_balances"].handler({ reportingCurrency: "USD" }, {}));
    const invest = data.accounts.find((a: { id: number }) => a.id === 2);
    expect(invest.balanceBasis).toBe("ledger");
    expect(invest.balance).toBe(0); // net contributions, NOT market
    expect(invest.cashFlowBasis).toBeUndefined();
    expect(data.note).toBeTruthy();
    // Total = 500 + 0 = 500 (the v3.2 ledger figure).
    expect(data.totalReporting.amount).toBe(500);
  });

  it("PARITY (DEK null): parity still holds AND basis is 'ledger' with a note", async () => {
    const { tools } = bootstrap(null);
    const bal = parse(await tools["get_account_balances"].handler({ reportingCurrency: "USD" }, {}));
    const nw = parse(await tools["get_net_worth"].handler({ reportingCurrency: "USD" }, {}));
    expect(nw.basis).toBe("ledger");
    expect(nw.note).toBeTruthy();
    expect(bal.totalReporting.amount).toBe(500);
    expect(nw.total.net.amount).toBe(500);
    expect(nw.total.net.amount).toBe(bal.totalReporting.amount);
  });
});
