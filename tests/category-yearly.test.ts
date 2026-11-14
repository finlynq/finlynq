/**
 * Category view, yearly grouping + all-time ranges (2026-11-13, in-app
 * feedback #32: "group by year and all dates"). Pure builder and window
 * helpers in lib/reports/category-detail.ts; the monthly builder is pinned
 * separately in tests/category-detail.test.ts and must not change.
 */

import { describe, it, expect } from "vitest";
import {
  allTimeMonths,
  allTimeYears,
  buildCategoryYearly,
  categoryYearWindow,
  monthsBetween,
  type CategoryTxRow,
} from "@/lib/reports/category-detail";

let nextId = 1;
const tx = (date: string, amount: number, payee: string | null = "Store"): CategoryTxRow => ({
  id: nextId++,
  date,
  payee,
  amount,
  currency: "USD",
  reportingAmount: null,
  reportingCurrency: null,
  accountName: "Visa",
});
const native = (r: CategoryTxRow) => r.amount;

describe("all-time ranges", () => {
  it("counts months inclusively across years", () => {
    expect(monthsBetween("2024-03", "2026-11")).toBe(33);
    expect(monthsBetween("2026-11", "2026-11")).toBe(1);
    expect(monthsBetween("2027-01", "2026-11")).toBe(1);
  });

  it("monthly All reaches the category's first transaction", () => {
    expect(allTimeMonths("2026-11-13", "2024-03-05")).toBe(33);
    expect(allTimeMonths("2026-11-13", null)).toBe(12); // no activity: still show a year
    expect(allTimeMonths("2026-11-13", "2027-01-01")).toBe(12); // only future-dated rows
  });

  it("yearly All reaches the first transaction's year", () => {
    expect(allTimeYears("2026-11-13", "2019-06-01")).toBe(8);
    expect(allTimeYears("2026-11-13", "2026-02-01")).toBe(1);
    expect(allTimeYears("2026-11-13", null)).toBe(1);
  });

  it("floors garbage dates at 1970 instead of walking centuries", () => {
    expect(allTimeYears("2026-11-13", "0002-01-01")).toBe(57);
    expect(allTimeMonths("2026-11-13", "0002-01-01")).toBe(monthsBetween("1970-01", "2026-11"));
  });
});

describe("categoryYearWindow", () => {
  it("covers whole calendar years ending with the current one", () => {
    expect(categoryYearWindow("2026-11-13", 3)).toEqual({
      currentYear: "2026",
      startYear: "2024",
      windowStart: "2024-01-01",
      windowStartMonth: "2024-01",
      queryStart: "2024-01-01",
    });
  });

  it("always queries last year, even for a one-year view", () => {
    expect(categoryYearWindow("2026-11-13", 1).queryStart).toBe("2025-01-01");
  });
});

describe("buildCategoryYearly", () => {
  const today = "2026-11-13";

  it("orients expenses positive, nets refunds and marks the running year", () => {
    const d = buildCategoryYearly({
      type: "E",
      rows: [tx("2025-03-01", -100), tx("2025-04-01", 20), tx("2026-01-05", -40)],
      budgets: new Map(),
      today,
      years: 3,
      toDisplay: native,
      typeTotal: 1200,
    });
    expect(d.years.map((y) => y.year)).toEqual(["2024", "2025", "2026"]);
    expect(d.years.map((y) => y.amount)).toEqual([0, 80, 40]);
    expect(d.years.map((y) => y.partial)).toEqual([false, false, true]);
    expect(d.stats.lastYear).toBe(80);
    expect(d.stats.thisYear).toBe(40);
    expect(d.stats.total).toBe(120);
    expect(d.stats.shareOfType).toBeCloseTo(0.1, 10);
  });

  it("orients income positive", () => {
    const d = buildCategoryYearly({
      type: "I",
      rows: [tx("2025-06-01", 5000), tx("2026-06-01", 5500)],
      budgets: new Map(),
      today,
      years: 3,
      toDisplay: native,
      typeTotal: 10500,
    });
    expect(d.stats.lastYear).toBe(5000);
    expect(d.stats.thisYear).toBe(5500);
  });

  it("compares this year with the same point last year, like for like", () => {
    const d = buildCategoryYearly({
      type: "E",
      rows: [tx("2025-11-13", -30), tx("2025-11-14", -500), tx("2025-01-01", -10)],
      budgets: new Map(),
      today,
      years: 3,
      toDisplay: native,
      typeTotal: 540,
    });
    expect(d.stats.samePeriodLastYear).toBe(40); // through 13 Nov 2025, not the 14th
    expect(d.stats.lastYear).toBe(540);
  });

  it("handles a leap day: 29 Feb compares with up to 28 Feb a year earlier", () => {
    const d = buildCategoryYearly({
      type: "E",
      rows: [tx("2027-02-28", -12), tx("2027-03-01", -99)],
      budgets: new Map(),
      today: "2028-02-29",
      years: 2,
      toDisplay: native,
      typeTotal: 111,
    });
    expect(d.stats.samePeriodLastYear).toBe(12);
  });

  it("averages complete years only, from the first year with activity", () => {
    const d = buildCategoryYearly({
      type: "E",
      rows: [tx("2024-05-01", -300), tx("2025-05-01", -100), tx("2026-05-01", -999)],
      budgets: new Map(),
      today,
      years: 5, // 2022..2026: 2022-2023 have no activity, 2026 is still running
      toDisplay: native,
      typeTotal: 1399,
    });
    expect(d.stats.averageYearly).toBe(200);
    expect(d.stats.medianYearly).toBe(200);
    expect(d.stats.highestYear).toEqual({ year: "2024", amount: 300 });
  });

  it("sums each year's monthly budgets and ignores future years", () => {
    const d = buildCategoryYearly({
      type: "E",
      rows: [tx("2026-02-01", -10)],
      budgets: new Map([
        ["2025-12", 50],
        ["2026-01", 100],
        ["2026-12", 100],
        ["2027-01", 999],
      ]),
      today,
      years: 2,
      toDisplay: native,
      typeTotal: 10,
    });
    expect(d.years.map((y) => [y.year, y.budget])).toEqual([["2025", 50], ["2026", 200]]);
    expect(d.hasBudget).toBe(true);
  });

  it("limits payees, recent rows and counts to the window", () => {
    const d = buildCategoryYearly({
      type: "E",
      rows: [tx("2023-06-01", -1000, "Old Shop"), tx("2025-06-01", -50, "New Shop"), tx("2026-12-01", -7, "Future")],
      budgets: new Map(),
      today,
      years: 2, // 2025..2026
      toDisplay: native,
      typeTotal: 50,
    });
    expect(d.topPayees.map((p) => p.payee)).toEqual(["New Shop"]);
    expect(d.recent.map((r) => r.payee)).toEqual(["New Shop"]);
    expect(d.stats.transactionCount).toBe(1);
    expect(d.stats.averageTransaction).toBe(50);
  });

  it("uses the converter for every money figure (FINLYNQ-123)", () => {
    const d = buildCategoryYearly({
      type: "E",
      rows: [tx("2025-06-01", -100), tx("2026-06-01", -100)],
      budgets: new Map(),
      today,
      years: 2,
      toDisplay: (r) => r.amount * 2,
      typeTotal: 400,
    });
    expect(d.stats.lastYear).toBe(200);
    expect(d.stats.thisYear).toBe(200);
    expect(d.topPayees[0].amount).toBe(400);
  });
});
