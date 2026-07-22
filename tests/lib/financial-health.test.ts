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

// ── Tiny SQL-matcher harness. ──────────────────────────────────────────────
// The calculator builds queries via Drizzle's sql template-tag, which serializes
// to a `{ queryChunks, getSQL, toQuery, ... }` object. We don't try to evaluate
// the SQL — we just match on substrings of the first chunk to dispatch to a
// fixture per-query-kind.

type FakeQueryDispatch = {
  incomeExpenses3m?: Array<{ month: string; cat_type: string; currency: string | null; total: number }>;
  incomeDebt12m?: Array<{ cat_type: string | null; currency: string | null; account_type: string | null; total: number }>;
  balances?: Array<{ type: string; group: string; currency: string | null; is_investment: boolean | null; balance: number }>;
  balancesPast?: Array<{ currency: string | null; balance: number }>;
  oldestRow?: Array<{ oldest: string | null }>;
  budgets?: Array<{ budget: number; spent: number }>;
};

function buildDb(dispatch: FakeQueryDispatch, capture?: { dtiSql?: string }) {
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
      if (repr.includes("a.type AS account_type")) {
        if (capture) capture.dtiSql = repr;
        return { rows: dispatch.incomeDebt12m ?? [] };
      }
      if (repr.includes("a.is_investment")) {
        return { rows: dispatch.balances ?? [] };
      }
      if (repr.includes("t.date <= ")) {
        return { rows: dispatch.balancesPast ?? [] };
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
      incomeDebt12m: [],
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
      incomeDebt12m: [],     // DTI → 100 (no debt)
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
  it("tc-1: DTI numerator excludes transfer/portfolio legs and yields a realistic DTI", async () => {
    aomMock.mockResolvedValue({ ageInDays: 20, trend: 0, history: [] });
    // Post-filter fixture: the SQL WHERE excludes any link-bearing row, so the
    // rows that reach the calculator are genuine debt SERVICE only — mortgage
    // interest + scheduled principal (~$3.7K/mo → ~$44.4K/yr) against ~$307K
    // income. A big loan-account TRANSFER (a $900K refi/CC-payment leg) carries
    // a link_id and is filtered OUT by the query, so it never appears here.
    const capture: { dtiSql?: string } = {};
    const db = buildDb(
      {
        incomeDebt12m: [
          { cat_type: "I", currency: "CAD", account_type: null, total: 307709.52 },
          // debt service that survived the transfer filter (amount < 0 on L acct)
          { cat_type: null, currency: "CAD", account_type: "L", total: -44400 },
        ],
        // Liabilities large enough that the anomaly guard does NOT trip:
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
    // The query text must carry the transfer/portfolio-leg exclusion.
    expect(capture.dtiSql).toContain("link_id IS NULL");
    expect(capture.dtiSql).toContain("trade_link_id IS NULL");
    expect(capture.dtiSql).toContain("swap_link_id IS NULL");
    // Numerator = 44,400 (debt service), NOT 44,400 + the 900K transfer.
    expect(r.totals.totalDebtPayments12m.amount).toBeCloseTo(44400, 0);
    // DTI = 44,400 / 307,709.52 ≈ 14.4% → realistic (single-digit-to-teens), not >100%.
    const dti = r.components.find((c) => c.name === "Debt-to-Income");
    expect(dti).toBeDefined();
    expect(dti!.detail).toMatch(/1[0-9]% debt-to-income/); // ~14%
    // score = (1 - 0.144) * 100 ≈ 85.6 → healthy, not floored at 0.
    expect(dti!.score).toBeGreaterThan(80);
  });

  it("tc-2: DTI is EXCLUDED via excludedComponents when 12m payments > 1.2× liabilities", async () => {
    aomMock.mockResolvedValue({ ageInDays: 20, trend: 0, history: [] });
    // Anomaly backstop: 12m debt payments ($1.2M) exceed 1.2× outstanding
    // liabilities ($838,194.15 × 1.2 = $1,005,832.98) — you cannot service more
    // than ~all your debt in a year, so the whole DTI component is excluded
    // (renormalizing) instead of scoring a misleading 0.
    const db = buildDb({
      incomeDebt12m: [
        { cat_type: "I", currency: "CAD", account_type: null, total: 307709.52 },
        { cat_type: null, currency: "CAD", account_type: "L", total: -1200000 }, // > 1.2 × 838,194
      ],
      balances: [
        { type: "L", group: "Mortgage", currency: "CAD", is_investment: false, balance: -838194.15 },
      ],
      oldestRow: [{ oldest: "2020-01-01" }],
      budgets: [{ budget: 100, spent: 50 }], // keep budget kept so DTI exclusion is isolated
    });
    const r = await calculateFinancialHealth({
      db,
      userId: "u",
      dek: null,
      reportingCurrency: "CAD",
    });
    // DTI is NOT a scored component — it was excluded.
    expect(r.components.find((c) => c.name === "Debt-to-Income")).toBeUndefined();
    expect(
      r.excludedComponents.some(
        (e) => e.name === "Debt-to-Income" && e.reason === "debt_payments_exceed_liabilities",
      ),
    ).toBe(true);
    // Overall score renormalizes over the remaining kept components (weights sum ~1).
    const renorm = r.components.reduce((s, c) => s + c.weight, 0);
    expect(renorm).toBeCloseTo(1, 2);
    // And the excluded DTI's 0-ish score no longer drags the total to a floor.
    expect(r.score).toBeGreaterThan(0);
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

  it("dti is reliable with the real ratio when payments stay within 1.2× liabilities", async () => {
    const db = buildDb({
      incomeDebt12m: [
        { cat_type: "I", currency: "CAD", account_type: null, total: 307709.52 },
        { cat_type: null, currency: "CAD", account_type: "L", total: -44400 },
      ],
      balances: [
        { type: "L", group: "Mortgage", currency: "CAD", is_investment: false, balance: -838194.15 },
      ],
      oldestRow: [{ oldest: "2020-01-01" }],
      budgets: [],
    });
    const r = await calculateFinancialHealth({ db, userId: "u", dek: null, reportingCurrency: "CAD" });
    expect(r.dti.reliable).toBe(true);
    // 44,400 / 307,709.52 ≈ 14.4% → 14
    expect(r.dti.pct).toBe(14);
  });

  it("dti.reliable is false but the raw ratio is still surfaced when the anomaly backstop fires", async () => {
    const db = buildDb({
      incomeDebt12m: [
        { cat_type: "I", currency: "CAD", account_type: null, total: 307709.52 },
        { cat_type: null, currency: "CAD", account_type: "L", total: -1200000 },
      ],
      balances: [
        { type: "L", group: "Mortgage", currency: "CAD", is_investment: false, balance: -838194.15 },
      ],
      oldestRow: [{ oldest: "2020-01-01" }],
      budgets: [{ budget: 100, spent: 50 }],
    });
    const r = await calculateFinancialHealth({ db, userId: "u", dek: null, reportingCurrency: "CAD" });
    // DTI is dropped from the composite score…
    expect(r.components.find((c) => c.name === "Debt-to-Income")).toBeUndefined();
    // …but the standalone figure is still computed and flagged unreliable so the
    // UI can caveat it (1,200,000 / 307,709.52 ≈ 390%).
    expect(r.dti.reliable).toBe(false);
    expect(r.dti.pct).toBe(390);
  });

  it("dti.pct is null when there is no income (12m)", async () => {
    const db = buildDb({
      incomeDebt12m: [
        { cat_type: null, currency: "CAD", account_type: "L", total: -5000 },
      ],
      oldestRow: [{ oldest: "2020-01-01" }],
      budgets: [],
    });
    const r = await calculateFinancialHealth({ db, userId: "u", dek: null, reportingCurrency: "CAD" });
    expect(r.dti.pct).toBeNull();
  });
});
