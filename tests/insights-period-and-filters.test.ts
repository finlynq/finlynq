/**
 * GH #454 / #455 / #457 (2026-11-25):
 *  - #454 "(Blank)" in the Transactions category filters = rows with no category.
 *  - #455 the account icon next to each transaction's account.
 *  - #457 dashboard Insights: real merchant spending, period-vs-period trends,
 *    a period picker, shown without dev mode.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NO_CATEGORY_FILTER_VALUE, parseCategoryFilter } from "@/lib/transactions/category-filter";
import { buildTransactionQuery } from "@/lib/transactions/build-query";
import { transactionsViewConfigSchema } from "@/lib/saved-views/config";
import { comparePeriods, merchantSpending } from "@/lib/spending-insights";
import { isInsightPeriod, rangeLabel, resolveInsightPeriod } from "@/lib/insights/period";

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

describe("#454 category filter (Blank)", () => {
  it("parses ids and the none token", () => {
    expect(parseCategoryFilter("12,none,7")).toEqual({ ids: [12, 7], includeNone: true });
    expect(parseCategoryFilter("none")).toEqual({ ids: [], includeNone: true });
    expect(parseCategoryFilter("12")).toEqual({ ids: [12], includeNone: false });
    expect(parseCategoryFilter("abc,0,-3,1.5")).toBeUndefined();
    expect(parseCategoryFilter("")).toBeUndefined();
    expect(parseCategoryFilter(null)).toBeUndefined();
  });

  it("travels through the query builder as typed", () => {
    const q = buildTransactionQuery(
      { categoryId: NO_CATEGORY_FILTER_VALUE },
      { columnId: null, direction: null },
      [{ type: "enum", columnId: "category", values: [NO_CATEGORY_FILTER_VALUE, "12"] }],
      [],
      { page: 0, limit: 50 },
    );
    expect(q.get("categoryId")).toBe("none");
    expect(q.get("categoryIds")).toBe("none,12");
  });

  it("can be saved in a Transactions view", () => {
    const field = transactionsViewConfigSchema.shape.categoryId;
    expect(field.safeParse("none").success).toBe(true);
    expect(field.safeParse("12").success).toBe(true);
    expect(field.safeParse("drop").success).toBe(false);
  });

  it("is offered in both filters and read by the route, the SQL and the calendar", () => {
    expect(read("src/app/(app)/transactions/_components/column-filter-popover.tsx")).toContain("NO_CATEGORY_FILTER_VALUE, label: NO_CATEGORY_FILTER_LABEL");
    expect(read("src/app/(app)/transactions/_components/transactions-workspace.tsx")).toContain("{ value: NO_CATEGORY_FILTER_VALUE, label: NO_CATEGORY_FILTER_LABEL }");
    const route = read("src/app/api/transactions/route.ts");
    expect(route).toContain('parseCategoryFilter(params.get("categoryId"))');
    expect(route).toContain('parseCategoryFilter(params.get("categoryIds"))');
    const queries = read("src/lib/queries.ts");
    expect(queries).toContain("if (filters?.categoryNone) conditions.push(isNull(transactions.categoryId));");
    expect(queries).toContain("or(inArray(transactions.categoryId, ids), isNull(transactions.categoryId))");
    expect(read("src/app/api/transactions/calendar/route.ts")).toContain("if (categoryNone) conditions.push(isNull(t.categoryId));");
  });
});

describe("#455 account icon in the transaction list", () => {
  it("the Account column draws the shared AccountAvatar with the logo versions", () => {
    const src = read("src/app/(app)/transactions/_components/transaction-table.tsx");
    expect(src).toContain("const { versions: logoVersions } = useAccountLogos();");
    expect(src).toContain("logoVersion={logoVersions[t.accountId]}");
  });
});

describe("#457 insights period", () => {
  it("resolves whole months and the same length before", () => {
    const p = resolveInsightPeriod("last_3", "2026-11-25");
    expect(p.months).toEqual(["2026-08", "2026-09", "2026-10"]);
    expect(p.previousMonths).toEqual(["2026-05", "2026-06", "2026-07"]);
    expect(p).toMatchObject({ from: "2026-08-01", to: "2026-10-31", previousFrom: "2026-05-01", previousTo: "2026-07-31" });
    expect(p.label).toBe("Aug – Oct 2026");
    expect(p.previousLabel).toBe("May – Jul 2026");
  });

  it("crosses years and labels a running period as so far", () => {
    const jan = resolveInsightPeriod("last_month", "2026-01-10");
    expect(jan.months).toEqual(["2025-12"]);
    expect(jan.previousMonths).toEqual(["2025-11"]);
    const ytd = resolveInsightPeriod("ytd", "2026-03-05");
    expect(ytd.months).toEqual(["2026-01", "2026-02", "2026-03"]);
    expect(ytd.to).toBe("2026-03-05");
    expect(ytd.label).toBe("Jan – Mar 2026 so far");
    expect(ytd.previousLabel).toBe("Oct – Dec 2025");
    expect(rangeLabel(["2025-12", "2026-01"])).toBe("Dec 2025 – Jan 2026");
    const feb = resolveInsightPeriod("last_12", "2026-03-31");
    expect(feb.previousTo).toBe("2025-02-28");
  });

  it("validates keys", () => {
    expect(isInsightPeriod("last_6")).toBe(true);
    expect(isInsightPeriod("forever")).toBe(false);
  });
});

describe("#457 merchant spending", () => {
  it("nets refunds, drops merchants refunded in full, and counts purchases", () => {
    const out = merchantSpending([
      { payee: "Shoe Store", amount: -120 },
      { payee: "shoe  store", amount: 20 }, // refund, other spelling
      { payee: "Cafe", amount: -4.5 },
      { payee: "Cafe", amount: -5.5 },
      { payee: "Returned Co", amount: -50 },
      { payee: "Returned Co", amount: 50 },
      { payee: "", amount: -99 },
    ]);
    expect(out.map((m) => m.payee)).toEqual(["Shoe Store", "Cafe"]);
    expect(out[0]).toMatchObject({ totalSpent: 100, count: 1 });
    expect(out[1]).toMatchObject({ totalSpent: 10, count: 2, avgTransaction: 5 });
  });
});

describe("#457 period-vs-period trends", () => {
  const rows = [
    { month: "2026-08", categoryName: "Groceries", categoryGroup: "Food", total: -300 },
    { month: "2026-09", categoryName: "Groceries", categoryGroup: "Food", total: -300 },
    { month: "2026-05", categoryName: "Groceries", categoryGroup: "Food", total: -200 },
    { month: "2026-06", categoryName: "Groceries", categoryGroup: "Food", total: -200 },
    { month: "2026-08", categoryName: "Gifts", categoryGroup: "Other", total: -80 },
    { month: "2026-06", categoryName: "Fuel", categoryGroup: "Car", total: -100 },
    { month: "2026-07", categoryName: "Fuel", categoryGroup: "Car", total: 10 }, // refund
    { month: "2026-01", categoryName: "Old", categoryGroup: "", total: -999 }, // outside both
  ];
  it("compares totals, marks new categories and nets refunds", () => {
    const out = comparePeriods(rows, ["2026-08", "2026-09", "2026-10"], ["2026-05", "2026-06", "2026-07"]);
    const by = Object.fromEntries(out.map((t) => [t.category, t]));
    expect(by.Groceries).toMatchObject({ currentTotal: 600, previousTotal: 400, changePercent: 50, trend: "rising" });
    expect(by.Gifts).toMatchObject({ currentTotal: 80, previousTotal: 0, changePercent: null, trend: "new" });
    expect(by.Fuel).toMatchObject({ currentTotal: 0, previousTotal: 90, changePercent: -100, trend: "declining" });
    expect(by.Old).toBeUndefined();
    expect(out[0].category).toBe("Groceries"); // biggest money change first
  });
});

describe("#457 wiring", () => {
  it("the dashboard shows Insights outside the dev-mode block and the route has no dev-mode guard", () => {
    const page = read("src/app/(app)/dashboard/page.tsx");
    const devBlock = page.slice(page.indexOf("{devMode && ("), page.indexOf("GH #457"));
    expect(devBlock).not.toContain("<InsightsSection");
    expect(page).toContain("<InsightsSection currency={apiDisplayCurrency} />");
    expect(read("src/app/api/insights/route.ts")).not.toContain("requireDevMode");
  });

  it("the period picker heads only Top Merchants and Category Trends", () => {
    const src = read("src/app/(app)/dashboard/_components/insights-section.tsx");
    const picker = src.indexOf('aria-label="Insights period"');
    expect(src.indexOf("{/* Spending Alerts */}")).toBeLessThan(picker);
    expect(src.indexOf("{/* Recurring */}")).toBeLessThan(picker);
    expect(src.indexOf("{/* Top Merchants */}")).toBeGreaterThan(picker);
    expect(src.indexOf("{/* Category Trends */}")).toBeGreaterThan(picker);
  });

  it("merchant rows come from expense categories without transfer, trade or bookkeeping rows", () => {
    const q = read("src/lib/queries.ts");
    const fn = q.slice(q.indexOf("export async function getMerchantSpendRows"), q.indexOf("export async function getSpendingByCategory"));
    for (const needle of [
      'eq(categories.type, "E")',
      "isNull(flows.linkId)",
      "isNull(flows.tradeLinkId)",
      "isNull(flows.swapLinkId)",
      "isNull(flows.portfolioHoldingId)",
      "NOT IN ('opening_balance', 'balance_adjustment')",
    ]) expect(fn).toContain(needle);
  });
});
