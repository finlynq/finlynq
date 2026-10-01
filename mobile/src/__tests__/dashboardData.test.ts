import { endpoints, setServerUrl } from "../api/client";
import {
  pickReferenceMonth,
  formatMonthLabel,
  sortBudgetsByRisk,
  resolveSavingsRate,
  monthKey,
} from "../lib/dashboard";
import type { BudgetWithSpending } from "../../../shared/types";

const mockFetch = jest.fn();
global.fetch = mockFetch;

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}

function prevMonthKey(d = new Date()): string {
  return monthKey(new Date(d.getFullYear(), d.getMonth() - 1, 1));
}

describe("pickReferenceMonth", () => {
  it("steps back from the current (partial) month to the last complete one", () => {
    const ref = pickReferenceMonth(
      [
        { month: "2026-08", type: "I", total: 5000 },
        { month: "2026-08", type: "E", total: -3000 },
        { month: "2026-09", type: "E", total: -400 },
      ],
      "2026-09",
    );
    expect(ref).toEqual({ month: "2026-08", income: 5000, expenses: 3000 });
  });

  it("keeps the current month when it is the only one tracked", () => {
    expect(pickReferenceMonth([{ month: "2026-09", type: "I", total: 10 }], "2026-09")).toEqual({
      month: "2026-09",
      income: 10,
      expenses: 0,
    });
  });

  it("uses the newest month when it is not the current one", () => {
    const ref = pickReferenceMonth(
      [
        { month: "2026-06", type: "I", total: 1 },
        { month: "2026-07", type: "I", total: 2 },
      ],
      "2026-09",
    );
    expect(ref?.month).toBe("2026-07");
  });

  it("returns null with no rows", () => {
    expect(pickReferenceMonth([], "2026-09")).toBeNull();
  });
});

describe("formatMonthLabel", () => {
  it("names the month", () => {
    expect(formatMonthLabel("2026-09")).toBe("September 2026");
    expect(formatMonthLabel("garbage")).toBe("garbage");
  });
});

describe("sortBudgetsByRisk", () => {
  const b = (id: number, spent: number, amount: number) =>
    ({ id, categoryId: id, month: "2026-09", amount, currency: "USD", convertedAmount: amount, convertedSpent: spent }) as BudgetWithSpending;

  it("orders by spent/budget ratio, highest first, stable on ties", () => {
    const sorted = sortBudgetsByRisk([b(1, 10, 100), b(2, 150, 100), b(3, 50, 100), b(4, 10, 100)]);
    expect(sorted.map((x) => x.id)).toEqual([2, 3, 1, 4]);
  });
});

describe("resolveSavingsRate", () => {
  const fallback = { savingsRate: 25.4, monthlyIncome: 1000, referenceMonth: "2026-08" };

  it("prefers the health 3-month rate and keeps negatives", () => {
    expect(resolveSavingsRate({ savingsRatePct: -12 }, fallback)).toEqual({
      pct: -12,
      period: "last 3 months",
    });
  });

  it("hides the rate when the server says there is no income (null)", () => {
    expect(resolveSavingsRate({ savingsRatePct: null }, fallback)).toBeNull();
  });

  it("falls back to the reference month when health is missing", () => {
    expect(resolveSavingsRate(null, fallback)).toEqual({ pct: 25, period: "August 2026" });
    expect(resolveSavingsRate(null, { ...fallback, monthlyIncome: 0 })).toBeNull();
  });
});

describe("composeDashboard / getAccountsOverview", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    setServerUrl("http://localhost:3000");
  });

  const currentMonth = monthKey();
  const lastMonth = prevMonthKey();

  function mockServer(dashboard: object) {
    mockFetch.mockImplementation((url: string) =>
      Promise.resolve(
        url.includes("/api/dashboard")
          ? jsonResponse(dashboard)
          : jsonResponse({ data: [], total: 0 }),
      ),
    );
  }

  it("threads displayCurrency, keeps archived balances in net worth, and uses the last complete month", async () => {
    mockServer({
      displayCurrency: "EUR",
      balances: [
        { accountId: 1, accountType: "A", balance: 100, convertedBalance: 100, currency: "EUR", displayCurrency: "EUR" },
        { accountId: 2, accountType: "A", balance: 50, convertedBalance: 50, currency: "EUR", displayCurrency: "EUR", archived: true },
        { accountId: 3, accountType: "L", balance: -30, convertedBalance: -30, currency: "EUR", displayCurrency: "EUR" },
      ],
      incomeVsExpenses: [
        { month: lastMonth, type: "I", total: 4000 },
        { month: lastMonth, type: "E", total: -1000 },
        { month: currentMonth, type: "E", total: -50 },
      ],
    });
    const res = await endpoints.getDashboard();
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.displayCurrency).toBe("EUR");
    expect(res.data.netWorth).toBe(120); // 100 + 50 (archived) − 30
    expect(res.data.totalAssets).toBe(150);
    expect(res.data.totalLiabilities).toBe(30);
    expect(res.data.referenceMonth).toBe(lastMonth);
    expect(res.data.monthlyIncome).toBe(4000);
    expect(res.data.monthlyExpenses).toBe(1000);
    expect(res.data.savingsRate).toBe(75);
    expect(res.data.accountBalances.every((b) => b.currency === "EUR")).toBe(true);
  });

  it("falls back to USD (never CAD) when the server omits displayCurrency", async () => {
    mockServer({ balances: [], incomeVsExpenses: [] });
    const res = await endpoints.getDashboard();
    expect(res.success && res.data.displayCurrency).toBe("USD");
    expect(res.success && res.data.referenceMonth).toBeNull();

    const overview = await endpoints.getAccountsOverview();
    expect(overview.success && overview.data.displayCurrency).toBe("USD");
  });

  it("getAccountsOverview returns every balance row (archived included) + the display currency", async () => {
    mockServer({
      displayCurrency: "CAD",
      balances: [
        { accountId: 1, accountType: "A", balance: 1, convertedBalance: 1, currency: "CAD", displayCurrency: "CAD" },
        { accountId: 2, accountType: "A", balance: 2, convertedBalance: 2, currency: "CAD", displayCurrency: "CAD", archived: true },
      ],
    });
    const res = await endpoints.getAccountsOverview();
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.displayCurrency).toBe("CAD");
    expect(res.data.balances.map((b) => b.accountId)).toEqual([1, 2]);
  });
});
