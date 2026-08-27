/**
 * Unit tests for the shared financial-health calculator (FINLYNQ-94).
 *
 * In-process tests over a mock `db.execute` shim. Real-Postgres coverage of
 * the same SQL invariants is deferred to a follow-up — these tests focus on
 * the load-bearing branches in the calculator's TypeScript:
 *
 *   1. budget-adherence is EXCLUDED (not 0 or 50/100) when no budgets exist
 *   2. net-worth-trend is EXCLUDED when oldest tx is < 60d old (insufficient
 *      history), not flat-at-50
 *   3. multi-currency totals sum through getRate FX conversion
 *   4. liquid-assets respects accounts.is_investment AND the CASH_GROUPS
 *      whitelist (substring matching on `group` is the wrong shape)
 *   5. age-of-money falls back to 50/excluded when calculateAgeOfMoney
 *      returns ageInDays=0
 *
 * If `finlynq_test` Postgres becomes available, these branches can be
 * promoted into the portfolio-fixtures style (real INSERTs into seeded
 * tables) without changing the calculator API.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import { calculateFinancialHealth, HEALTH_WEIGHTS } from "@/lib/financial-health";

const fxMock = vi.fn(async (from: string, to: string): Promise<number> => {
  if (from === to) return 1;
  if (from === "USD" && to === "CAD") return 1.35;
  if (from === "CAD" && to === "USD") return 1 / 1.35;
  return 1;
});

vi.mock("@/lib/fx-service", () => ({
  getRate: (from: string, to: string) => fxMock(from, to),
}));

const aomMock = vi.fn();
vi.mock("@/lib/age-of-money", () => ({
  calculateAgeOfMoney: (...a: unknown[]) => aomMock(...a),
}));

// The calculator marks investment accounts to MARKET through the shared
// `applyInvestmentMarketOverlay`, which reaches the real pricing stack. Mock
// the two holdings entry points so the net-worth branch is testable in-process.
// `holdingsMock` is keyed by asOfDate: `undefined` is today, a date string is
// the 90-day-ago pass, so a test can give the trend two different valuations.
const holdingsMock = vi.fn();
const decryptHealthMock = vi.fn(async () => ({ failed: 0, total: 0 }));
vi.mock("@/lib/holdings-value", () => ({
  getHoldingsValueByAccount: (...a: unknown[]) => holdingsMock(...a),
  verifyHoldingDecryptHealth: () => decryptHealthMock(),
}));

// ── Tiny SQL-matcher harness. ──────────────────────────────────────────────
// The calculator builds queries via Drizzle's sql template-tag, which serializes
// to a `{ queryChunks, getSQL, toQuery, ... }` object. We don't try to evaluate
// the SQL — we just match on substrings of the first chunk to dispatch to a
// fixture per-query-kind.

type FakeQueryDispatch = {
  incomeExpenses3m?: Array<{ month: string; cat_type: string; currency: string | null; total: number }>;
  /** GH #333 follow-up: the single incomeDebt12m query was split into three.
   *  Income is now its own query; the debt numerator comes from `loans` +
   *  realized payments on liabilities no loan points at. */
  income12m?: Array<{ currency: string | null; total: number }>;
  loans?: Array<Record<string, unknown>>;
  /** Realized payments on liability accounts no loan points at, PER ACCOUNT
   *  (2026-08-27) — the grain the pay-in-full cap is applied at. */
  untrackedPayments?: Array<{
    account_id: number;
    account_currency: string | null;
    currency: string | null;
    total: number;
  }>;
  /** Balance owed by each liability account at both window endpoints, stored
   *  NEGATIVE-when-owed exactly as Postgres returns it. Defaults to a deeply
   *  indebted account so a fixture that does not care about the cap is not
   *  silently capped to zero. */
  liabilityBalances?: Array<{
    account_id: number;
    currency: string | null;
    opening_balance: number;
    closing_balance: number;
  }>;
  balances?: Array<{ id?: number; type: string; group: string; currency: string | null; is_investment: boolean | null; balance: number }>;
  balancesPast?: Array<{ id?: number; currency: string | null; is_investment?: boolean | null; balance: number }>;
  oldestRow?: Array<{ oldest: string | null }>;
  budgets?: Array<{ budget: number; spent: number }>;
};

function buildDb(
  dispatch: FakeQueryDispatch,
  capture?: { incomeSql?: string; loansSql?: string; untrackedSql?: string },
) {
  return {
    execute: vi.fn(async (q: unknown) => {
      // Drizzle's `sql` template literal yields an object with a `queryChunks`
      // array of alternating string fragments + parameter sigils. We walk it
      // and concatenate string fragments only — enough to match on the literal
      // SQL hints we put in each query.
      const chunks = (q as { queryChunks?: unknown[] })?.queryChunks ?? [];
      let repr = "";
      for (const chunk of chunks) {
        if (typeof chunk === "string") {
          repr += chunk;
        } else if (chunk && typeof chunk === "object") {
          const rec = chunk as Record<string, unknown>;
          // StringChunk has a `value` array of strings.
          if (Array.isArray(rec.value)) {
            for (const v of rec.value) {
              if (typeof v === "string") repr += v;
            }
          } else if (typeof rec.value === "string") {
            repr += rec.value;
          }
        }
      }

      // Order matters: most specific first.
      if (repr.includes("TO_CHAR(t.date::date, 'YYYY-MM')")) {
        return { rows: dispatch.incomeExpenses3m ?? [] };
      }
      // Order matters: the untracked-payments query CONTAINS a `FROM loans`
      // sub-select, so it must be matched before the standalone loans query.
      if (repr.includes("FROM loans l")) {
        if (capture) capture.untrackedSql = repr;
        return { rows: dispatch.untrackedPayments ?? [] };
      }
      if (repr.includes("residual_value")) {
        if (capture) capture.loansSql = repr;
        return { rows: dispatch.loans ?? [] };
      }
      if (repr.includes("c.type = 'I'")) {
        if (capture) capture.incomeSql = repr;
        return { rows: dispatch.income12m ?? [] };
      }
      // Order matters, and it changed 2026-08-27. Three queries now mention
      // `a.is_investment` and/or `t.date <= `, so match on what is UNIQUE to
      // each, most specific first:
      //   - the liability-endpoint query is the only one with a FILTER clause
      //   - the 90-day-ago balances query is the only OTHER one bounded by
      //     `t.date <= ` (it gained `a.is_investment` so the past side can be
      //     marked to market on the same basis as today)
      //   - today's balances query is what is left
      if (repr.includes("FILTER (WHERE t.date <")) {
        return {
          rows:
            dispatch.liabilityBalances ??
            // Default: deeply indebted, so a fixture that is not exercising the
            // pay-in-full cap is not silently capped to zero by it.
            (dispatch.untrackedPayments ?? []).map((r) => ({
              account_id: r.account_id,
              currency: r.account_currency,
              opening_balance: -1_000_000_000,
              closing_balance: -1_000_000_000,
            })),
        };
      }
      if (repr.includes("t.date <= ")) {
        return { rows: dispatch.balancesPast ?? [] };
      }
      if (repr.includes("a.is_investment")) {
        return { rows: dispatch.balances ?? [] };
      }
      if (repr.includes("MIN(t.date)")) {
        return { rows: dispatch.oldestRow ?? [] };
      }
      if (repr.includes("FROM budgets")) {
        return { rows: dispatch.budgets ?? [] };
      }
      return { rows: [] };
    }),
  };
}

/** A `loans` row as the calculator's raw SQL returns it (snake_case). A
 *  24,000 @ 6% / 60mo loan running for the whole window ≈ 463.97/mo ≈ 5,568/yr. */
function loanRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    account_id: null,
    currency: "CAD",
    principal: 24000,
    annual_rate: 6,
    term_months: 60,
    start_date: "2020-01-01",
    payment_amount: null,
    payment_frequency: "monthly",
    extra_payment: 0,
    residual_value: null,
    ...over,
  };
}

describe("calculateFinancialHealth — load-bearing branches", () => {
  beforeEach(() => {
    fxMock.mockClear();
    aomMock.mockReset();
    aomMock.mockResolvedValue({ ageInDays: 0, trend: 0, history: [] });
  });

  it("weights sum to 1.0 (canonical FINLYNQ-94 contract)", () => {
    const sum = Object.values(HEALTH_WEIGHTS).reduce((s, w) => s + w, 0);
    expect(sum).toBeCloseTo(1, 9);
  });

  it("budget-adherence is EXCLUDED (not 0/100) when no budgets exist", async () => {
    aomMock.mockResolvedValue({ ageInDays: 20, trend: 0, history: [] });
    const db = buildDb({
      incomeExpenses3m: [],
      income12m: [],
      balances: [],
      balancesPast: [],
      oldestRow: [{ oldest: "2020-01-01" }], // plenty of history → NW trend not excluded
      budgets: [],
    });
    const r = await calculateFinancialHealth({
      db,
      userId: "u",
      dek: null,
      reportingCurrency: "CAD",
    });
    const budgetComp = r.components.find((c) => c.name === "Budget Adherence");
    expect(budgetComp).toBeUndefined();
    expect(r.excludedComponents.some((e) => e.name === "Budget Adherence" && e.reason === "no_budgets"))
      .toBe(true);
  });

  it("net-worth-trend is EXCLUDED (not 50-fallback) when history < 60 days", async () => {
    aomMock.mockResolvedValue({ ageInDays: 20, trend: 0, history: [] });
    const today = new Date();
    const recent = new Date(today);
    recent.setDate(recent.getDate() - 10); // only 10d of history
    const db = buildDb({
      oldestRow: [{ oldest: recent.toISOString().split("T")[0] }],
      budgets: [{ budget: 100, spent: 50 }], // keep budget kept so NW exclusion is isolated
    });
    const r = await calculateFinancialHealth({
      db,
      userId: "u",
      dek: null,
      reportingCurrency: "CAD",
    });
    const nwComp = r.components.find((c) => c.name === "Net Worth Trend");
    expect(nwComp).toBeUndefined();
    expect(r.excludedComponents.some((e) => e.name === "Net Worth Trend" && e.reason === "insufficient_history"))
      .toBe(true);
  });

  it("multi-currency totals convert via getRate (CAD + USD → CAD reporting)", async () => {
    aomMock.mockResolvedValue({ ageInDays: 20, trend: 0, history: [] });
    const today = new Date();
    const month = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
    const db = buildDb({
      incomeExpenses3m: [
        { month, cat_type: "I", currency: "CAD", total: 1000 },
        { month, cat_type: "I", currency: "USD", total: 1000 }, // → 1350 CAD
        { month, cat_type: "E", currency: "CAD", total: -500 },
        { month, cat_type: "E", currency: "USD", total: -100 }, // → 135 CAD abs
      ],
      oldestRow: [{ oldest: "2020-01-01" }],
      budgets: [],
    });
    const r = await calculateFinancialHealth({
      db,
      userId: "u",
      dek: null,
      reportingCurrency: "CAD",
    });
    // income = 1000 + 1350 = 2350; expenses = 500 + 135 = 635
    expect(r.totals.totalIncome3m.amount).toBeCloseTo(2350, 0);
    expect(r.totals.totalExpenses3m.amount).toBeCloseTo(635, 0);
    expect(r.totals.totalIncome3m.currency).toBe("CAD");
    expect(fxMock).toHaveBeenCalledWith("USD", "CAD");
  });

  it("liquid-assets respects is_investment AND the CASH_GROUPS whitelist", async () => {
    aomMock.mockResolvedValue({ ageInDays: 20, trend: 0, history: [] });
    const db = buildDb({
      balances: [
        // Banks + non-investment → counted
        { type: "A", group: "Banks", currency: "CAD", is_investment: false, balance: 5000 },
        // Cash + non-investment → counted
        { type: "A", group: "Cash", currency: "CAD", is_investment: false, balance: 2000 },
        // Banks + investment=true → EXCLUDED (locked-in RRSP cash)
        { type: "A", group: "Banks", currency: "CAD", is_investment: true, balance: 99000 },
        // Real Estate (non-cash group) + non-investment → EXCLUDED
        { type: "A", group: "Real Estate", currency: "CAD", is_investment: false, balance: 500000 },
        // Retirement Accounts (NOT in whitelist) → EXCLUDED
        { type: "A", group: "Retirement Accounts", currency: "CAD", is_investment: false, balance: 100000 },
        // Liability
        { type: "L", group: "Credit Cards", currency: "CAD", is_investment: false, balance: -1500 },
      ],
      oldestRow: [{ oldest: "2020-01-01" }],
      budgets: [],
    });
    const r = await calculateFinancialHealth({
      db,
      userId: "u",
      dek: null,
      reportingCurrency: "CAD",
    });
    expect(r.totals.liquidAssets.amount).toBeCloseTo(7000, 0);
    expect(r.totals.totalLiabilities.amount).toBeCloseTo(1500, 0);
  });

  it("age-of-money is EXCLUDED when calculateAgeOfMoney returns ageInDays=0", async () => {
    aomMock.mockResolvedValue({ ageInDays: 0, trend: 0, history: [] });
    const db = buildDb({
      oldestRow: [{ oldest: "2020-01-01" }],
      budgets: [],
    });
    const r = await calculateFinancialHealth({
      db,
      userId: "u",
      dek: null,
      reportingCurrency: "CAD",
    });
    const aomComp = r.components.find((c) => c.name === "Age of Money");
    expect(aomComp).toBeUndefined();
    expect(r.excludedComponents.some((e) => e.name === "Age of Money" && e.reason === "insufficient_data"))
      .toBe(true);
  });

  it("renormalizes remaining weights when components are excluded", async () => {
    aomMock.mockResolvedValue({ ageInDays: 0, trend: 0, history: [] });
    // Exclude Budget Adherence (no budgets), Net Worth Trend (insufficient history),
    // and Age of Money (ageInDays=0). Kept: Savings Rate (0.25) + DTI (0.20) +
    // Emergency Fund (0.15) = 0.60 → renormalized weights are 25/60, 20/60, 15/60.
    const today = new Date();
    const recent = new Date(today);
    recent.setDate(recent.getDate() - 10);
    const db = buildDb({
      incomeExpenses3m: [], // Savings Rate → 0
      income12m: [],     // DTI → 100 (no debt)
      balances: [],
      oldestRow: [{ oldest: recent.toISOString().split("T")[0] }],
      budgets: [],
    });
    const r = await calculateFinancialHealth({
      db,
      userId: "u",
      dek: null,
      reportingCurrency: "CAD",
    });
    const names = r.components.map((c) => c.name).sort();
    expect(names).toEqual(["Debt-to-Income", "Emergency Fund", "Savings Rate"]);
    const renorm = r.components.reduce((s, c) => s + c.weight, 0);
    expect(renorm).toBeCloseTo(1, 2);
  });

  // ── FINLYNQ-255: DTI numerator = genuine debt service only ────────────────
  it("tc-1: DTI numerator is SCHEDULED loan service, not unpaired negative liability rows", async () => {
    aomMock.mockResolvedValue({ ageInDays: 20, trend: 0, history: [] });
    // GH #333 follow-up. Liability balances are stored NEGATIVE-when-owed, so
    // the old `a.type='L' AND amount<0 AND <no link ids>` predicate selected new
    // BORROWING (charges, fees, accrued interest) and excluded real payments
    // twice over — wrong sign AND link-excluded. The numerator is now the
    // contractual payment on tracked loans.
    //
    // A mortgage at 3,700/mo → ~44.4K/yr against ~307.7K income ≈ 14%.
    const capture: { incomeSql?: string; loansSql?: string; untrackedSql?: string } = {};
    const db = buildDb(
      {
        income12m: [{ currency: "CAD", total: 307709.52 }],
        loans: [
          loanRow({ principal: 838194.15, annual_rate: 3.2, term_months: 300 }),
        ],
        untrackedPayments: [],
        balances: [
          { type: "L", group: "Mortgage", currency: "CAD", is_investment: false, balance: -838194.15 },
        ],
        oldestRow: [{ oldest: "2020-01-01" }],
        budgets: [],
      },
      capture,
    );
    const r = await calculateFinancialHealth({
      db,
      userId: "u",
      dek: null,
      reportingCurrency: "CAD",
    });

    // The realized-payment query must scope to liabilities NO loan points at,
    // or a transfer into a loan account is counted twice.
    expect(capture.untrackedSql).toContain("NOT EXISTS");
    // No link_id requirement: only createTransferPair stamps one, so imported
    // and hand-entered card payments carry none. Requiring it reported DTI as
    // 0% against a real card balance (caught on prod 2026-08-23).
    expect(capture.untrackedSql).not.toContain("t.link_id IS NOT NULL");
    expect(capture.untrackedSql).toContain("t.amount > 0");

    // ~300mo @ 3.2% on 838,194 ≈ 4,060/mo ≈ 48.7K/yr.
    expect(r.totals.totalDebtPayments12m.amount).toBeGreaterThan(40000);
    expect(r.totals.totalDebtPayments12m.amount).toBeLessThan(60000);

    const dti = r.components.find((c) => c.name === "Debt-to-Income");
    expect(dti).toBeDefined();
    expect(dti!.detail).toMatch(/1[0-9]% debt-to-income/);
    expect(dti!.score).toBeGreaterThan(80);
    // Nothing came from the realized path, so the figure is authoritative.
    expect(r.dti.reliable).toBe(true);
  });

  it("tc-2: DTI is NO LONGER dropped by the 1.2x-liabilities backstop", async () => {
    aomMock.mockResolvedValue({ ageInDays: 20, trend: 0, history: [] });
    // The backstop existed to contain a numerator that could exceed everything
    // the user owed — a symptom of the mis-signed predicate, not a data
    // anomaly. It was observed firing on our own demo dataset. Removing it
    // matters most for a NEARLY-REPAID loan: a year of payments legitimately
    // exceeds 1.2x the small remaining balance, and the old guard would have
    // silently dropped the component for exactly the user who is nearly done
    // paying it off.
    const db = buildDb({
      income12m: [{ currency: "CAD", total: 307709.52 }],
      loans: [loanRow({ principal: 24000, annual_rate: 6, term_months: 60 })],
      untrackedPayments: [],
      balances: [
        // Almost paid off — 12m of service (~5.6K) exceeds 1.2 x 2,000.
        { type: "L", group: "Loans", currency: "CAD", is_investment: false, balance: -2000 },
      ],
      oldestRow: [{ oldest: "2020-01-01" }],
      budgets: [{ budget: 100, spent: 50 }],
    });
    const r = await calculateFinancialHealth({
      db,
      userId: "u",
      dek: null,
      reportingCurrency: "CAD",
    });
    const dti = r.components.find((c) => c.name === "Debt-to-Income");
    expect(dti).toBeDefined();
    expect(
      r.excludedComponents.some((e) => e.name === "Debt-to-Income"),
    ).toBe(false);
    const renorm = r.components.reduce((s, c) => s + c.weight, 0);
    expect(renorm).toBeCloseTo(1, 2);
  });

  it("returns a valid grade for any score", async () => {
    aomMock.mockResolvedValue({ ageInDays: 0, trend: 0, history: [] });
    const db = buildDb({
      oldestRow: [{ oldest: "2020-01-01" }],
      budgets: [],
    });
    const r = await calculateFinancialHealth({
      db,
      userId: "u",
      dek: null,
      reportingCurrency: "CAD",
    });
    expect(["Excellent", "Good", "Fair", "Needs Work"]).toContain(r.grade);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
  });
});

// ── FINLYNQ-291: standalone savings-rate & DTI percentages ───────────────────
describe("calculateFinancialHealth — net worth is ONE calculation (2026-08-27)", () => {
  /** Cash 100k + a brokerage whose ledger sum is 300k of contributions but
   *  whose holdings are worth 400k today. */
  function investmentDb(over: Record<string, unknown> = {}) {
    return buildDb({
      income12m: [],
      loans: [],
      untrackedPayments: [],
      balances: [
        { id: 1, type: "A", group: "Banks", currency: "CAD", is_investment: false, balance: 100000 },
        { id: 2, type: "A", group: "Investments", currency: "CAD", is_investment: true, balance: 300000 },
      ],
      balancesPast: [
        { id: 1, currency: "CAD", is_investment: false, balance: 100000 },
        { id: 2, currency: "CAD", is_investment: true, balance: 300000 },
      ],
      oldestRow: [{ oldest: "2020-01-01" }],
      budgets: [],
      ...over,
    });
  }

  beforeEach(() => {
    fxMock.mockClear();
    aomMock.mockReset();
    aomMock.mockResolvedValue({ ageInDays: 0, trend: 0, history: [] });
    holdingsMock.mockReset();
    decryptHealthMock.mockClear();
  });

  it("values investment accounts at MARKET, not at SUM(transactions.amount)", async () => {
    // The reported bug: the health card read C$485,714 beside a dashboard
    // reading C$589,864 on the same data. An investment account's tx-sum is net
    // CONTRIBUTIONS — a buy writes a +stock/-cash pair that nets to zero — so
    // every dollar of unrealized gain was invisible here and nowhere else.
    holdingsMock.mockResolvedValue(
      new Map([[2, { accountId: 2, value: 400000, costBasis: 300000, currency: "CAD" }]]),
    );
    const r = await calculateFinancialHealth({
      db: investmentDb(),
      userId: "u",
      dek: Buffer.alloc(32),
      reportingCurrency: "CAD",
    });
    expect(r.totals.netWorthToday.amount).toBeCloseTo(500000, 0);
    expect(r.netWorthBasis).toBe("market");
  });

  it("marks BOTH ends of the 3-month trend to market, so a basis shift is not growth", async () => {
    // Today 400k, 90 days ago 350k, contributions flat at 300k throughout.
    // Marking only today would compare 500k against a 400k ledger past and
    // report ~25% growth that never happened; the real move is ~11%.
    holdingsMock.mockImplementation(async (_u: string, _d: unknown, opts?: { asOfDate?: string }) =>
      opts?.asOfDate
        ? new Map([[2, { accountId: 2, value: 350000, costBasis: 300000, currency: "CAD" }]])
        : new Map([[2, { accountId: 2, value: 400000, costBasis: 300000, currency: "CAD" }]]),
    );
    const r = await calculateFinancialHealth({
      db: investmentDb(),
      userId: "u",
      dek: Buffer.alloc(32),
      reportingCurrency: "CAD",
    });
    expect(r.totals.netWorthToday.amount).toBeCloseTo(500000, 0);
    expect(r.totals.netWorth90DaysAgo.amount).toBeCloseTo(450000, 0);
    const trend = r.components.find((c) => c.name === "Net Worth Trend");
    expect(trend?.detailRich?.magnitudePct).toBeCloseTo(10, 0);
  });

  it("falls back to ledger — on BOTH ends — without a DEK, and says so", async () => {
    // A `pf_` MCP API key cannot decrypt holding symbols, and pricing an
    // undecryptable symbol yields qty x 1 garbage. Ledger on both ends is at
    // least self-consistent; `netWorthBasis` is what stops a caller presenting
    // it as market value.
    const r = await calculateFinancialHealth({
      db: investmentDb(),
      userId: "u",
      dek: null,
      reportingCurrency: "CAD",
    });
    expect(holdingsMock).not.toHaveBeenCalled();
    expect(r.totals.netWorthToday.amount).toBeCloseTo(400000, 0);
    expect(r.netWorthBasis).toBe("ledger");
    expect(r.netWorthNote).toBeTruthy();
  });

  it("does not let the market pass move liquid assets or total liabilities", async () => {
    // Liquid assets already exclude `is_investment` accounts and liabilities are
    // never investment rows, so the overlay must be a no-op for both. If this
    // ever fails, an investment account has leaked into the emergency-fund
    // numerator.
    holdingsMock.mockResolvedValue(
      new Map([[2, { accountId: 2, value: 400000, costBasis: 300000, currency: "CAD" }]]),
    );
    const r = await calculateFinancialHealth({
      db: investmentDb(),
      userId: "u",
      dek: Buffer.alloc(32),
      reportingCurrency: "CAD",
    });
    expect(r.totals.liquidAssets.amount).toBeCloseTo(100000, 0);
    expect(r.totals.totalLiabilities.amount).toBeCloseTo(0, 0);
  });
});

describe("calculateFinancialHealth — savingsRatePct + dti standalone figures", () => {
  beforeEach(() => {
    fxMock.mockClear();
    aomMock.mockReset();
    aomMock.mockResolvedValue({ ageInDays: 0, trend: 0, history: [] });
  });

  it("savingsRatePct = round((income − expenses) / income) over the 3-month window", async () => {
    const today = new Date();
    const month = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
    const db = buildDb({
      incomeExpenses3m: [
        { month, cat_type: "I", currency: "CAD", total: 1000 },
        { month, cat_type: "E", currency: "CAD", total: -250 },
      ],
      oldestRow: [{ oldest: "2020-01-01" }],
      budgets: [],
    });
    const r = await calculateFinancialHealth({ db, userId: "u", dek: null, reportingCurrency: "CAD" });
    // (1000 − 250) / 1000 = 75%
    expect(r.savingsRatePct).toBe(75);
  });

  it("savingsRatePct is null when there is no income", async () => {
    const db = buildDb({
      incomeExpenses3m: [],
      oldestRow: [{ oldest: "2020-01-01" }],
      budgets: [],
    });
    const r = await calculateFinancialHealth({ db, userId: "u", dek: null, reportingCurrency: "CAD" });
    expect(r.savingsRatePct).toBeNull();
  });

  it("dti is reliable when the whole numerator is scheduled loan service", async () => {
    const db = buildDb({
      income12m: [{ currency: "CAD", total: 307709.52 }],
      loans: [loanRow({ principal: 838194.15, annual_rate: 3.2, term_months: 300 })],
      untrackedPayments: [],
      balances: [
        { type: "L", group: "Mortgage", currency: "CAD", is_investment: false, balance: -838194.15 },
      ],
      oldestRow: [{ oldest: "2020-01-01" }],
      budgets: [],
    });
    const r = await calculateFinancialHealth({ db, userId: "u", dek: null, reportingCurrency: "CAD" });
    expect(r.dti.reliable).toBe(true);
    expect(r.dti.pct).toBeGreaterThan(10);
    expect(r.dti.pct).toBeLessThan(20);
  });

  it("counts an untracked card's payments in full while they stay under the balance carried", async () => {
    // A revolver carrying 30,000 who paid 24,000 is measured exactly: the
    // pay-in-full cap must never reduce genuine debt service, and this stays
    // reliable.
    const db = buildDb({
      income12m: [{ currency: "CAD", total: 100000 }],
      loans: [],
      untrackedPayments: [
        { account_id: 1, account_currency: "CAD", currency: "CAD", total: 24000 },
      ],
      liabilityBalances: [
        { account_id: 1, currency: "CAD", opening_balance: -30000, closing_balance: -30000 },
      ],
      balances: [
        { id: 1, type: "L", group: "Credit Cards", currency: "CAD", is_investment: false, balance: -30000 },
      ],
      oldestRow: [{ oldest: "2020-01-01" }],
      budgets: [{ budget: 100, spent: 50 }],
    });
    const r = await calculateFinancialHealth({ db, userId: "u", dek: null, reportingCurrency: "CAD" });
    expect(r.dti.reliable).toBe(true);
    expect(r.dti.pct).toBe(24);
    // Still a scored component — the old backstop would have dropped it.
    expect(r.components.find((c) => c.name === "Debt-to-Income")).toBeDefined();
  });

  it("drops a card paid in full from DTI and marks the figure unreliable", async () => {
    // 2026-08-27, reported by the user: for someone who clears their card every
    // cycle, counting the payments as debt service measures card SPEND, not
    // debt — 24,000 of groceries became a 24% debt-to-income ratio. With
    // nothing carried at either endpoint the card contributes 0, and
    // `reliable:false` tells the UI a cap was applied.
    const db = buildDb({
      income12m: [{ currency: "CAD", total: 100000 }],
      loans: [],
      untrackedPayments: [
        { account_id: 1, account_currency: "CAD", currency: "CAD", total: 24000 },
      ],
      liabilityBalances: [
        { account_id: 1, currency: "CAD", opening_balance: 0, closing_balance: 0 },
      ],
      balances: [
        { id: 1, type: "L", group: "Credit Cards", currency: "CAD", is_investment: false, balance: 0 },
      ],
      oldestRow: [{ oldest: "2020-01-01" }],
      budgets: [{ budget: 100, spent: 50 }],
    });
    const r = await calculateFinancialHealth({ db, userId: "u", dek: null, reportingCurrency: "CAD" });
    expect(r.dti.pct).toBe(0);
    expect(r.dti.reliable).toBe(false);
    expect(r.totals.totalDebtPayments12m.amount).toBe(0);
    expect(r.components.find((c) => c.name === "Debt-to-Income")?.detail).toContain(
      "counted as spending",
    );
  });

  it("dti.pct is null when there is no income (12m)", async () => {
    const db = buildDb({
      income12m: [],
      untrackedPayments: [
        { account_id: 1, account_currency: "CAD", currency: "CAD", total: 5000 },
      ],
      loans: [],
      oldestRow: [{ oldest: "2020-01-01" }],
      budgets: [],
    });
    const r = await calculateFinancialHealth({ db, userId: "u", dek: null, reportingCurrency: "CAD" });
    expect(r.dti.pct).toBeNull();
  });
});
