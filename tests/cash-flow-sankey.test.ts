/** Reports → Cash Flow: income sources → one pool → spending + surplus/deficit. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  buildCashFlowColumns,
  foldSmallItems,
  DEFICIT_LABEL,
  OTHER_INCOME_LABEL,
  OTHER_SPENDING_LABEL,
  SURPLUS_LABEL,
} from "@/lib/reports/cash-flow-sankey";

const sum = (xs: { value: number }[]) => xs.reduce((s, x) => s + x.value, 0);

describe("buildCashFlowColumns", () => {
  it("adds a Surplus node on the right when income beats spending, and both sides equal the pool", () => {
    const c = buildCashFlowColumns(
      [{ name: "Wages", value: 5000 }, { name: "Interest", value: 200 }],
      [{ name: "Rent", value: 2000 }, { name: "Groceries", value: 800 }],
    );
    expect(c.pool).toBe(5200);
    expect(c.surplus).toBe(2400);
    expect(c.deficit).toBe(0);
    expect(c.uses.at(-1)).toEqual({ name: SURPLUS_LABEL, value: 2400, kind: "surplus" });
    expect(c.sources.some((n) => n.kind === "deficit")).toBe(false);
    expect(sum(c.sources)).toBeCloseTo(c.pool);
    expect(sum(c.uses)).toBeCloseTo(c.pool);
  });

  it("adds a Deficit node on the left when spending beats income", () => {
    const c = buildCashFlowColumns([{ name: "Wages", value: 1000 }], [{ name: "Rent", value: 1500 }]);
    expect(c.pool).toBe(1500);
    expect(c.deficit).toBe(500);
    expect(c.sources.at(-1)).toEqual({ name: DEFICIT_LABEL, value: 500, kind: "deficit" });
    expect(c.uses.some((n) => n.kind === "surplus")).toBe(false);
    expect(sum(c.sources)).toBeCloseTo(c.pool);
    expect(sum(c.uses)).toBeCloseTo(c.pool);
  });

  it("keeps every expense in the totals: the long tail folds into Other spending instead of vanishing", () => {
    const expenses = Array.from({ length: 15 }, (_, i) => ({ name: `E${i}`, value: 100 }));
    const c = buildCashFlowColumns([{ name: "Wages", value: 3000 }], expenses);
    expect(c.totalExpenses).toBe(1500);
    expect(c.surplus).toBe(1500); // with the old top-10 cut it read 2000
    const spending = c.uses.filter((n) => n.kind !== "surplus");
    expect(spending).toHaveLength(10);
    expect(spending.at(-1)).toEqual({ name: OTHER_SPENDING_LABEL, value: 600, kind: "other" });
  });

  it("drops zero and negative rows and handles an empty period", () => {
    const c = buildCashFlowColumns([{ name: "Refund", value: -50 }], [{ name: "Rent", value: 0 }]);
    expect(c.pool).toBe(0);
    expect(c.sources).toEqual([]);
    expect(c.uses).toEqual([]);
  });
});

describe("foldSmallItems", () => {
  it("folds items under 1% of the pool into Other, so tiny labels don't stack on top of each other", () => {
    const nodes = foldSmallItems(
      [
        { name: "Business", value: 9000 },
        { name: "Wages", value: 900 },
        { name: "Dividends", value: 40 },
        { name: "Credit interest", value: 30 },
        { name: "Other income", value: 30 },
      ],
      { maxItems: 7, pool: 10000, otherLabel: OTHER_INCOME_LABEL, kind: "income" },
    );
    expect(nodes.map((n) => n.name)).toEqual(["Business", "Wages", OTHER_INCOME_LABEL]);
    expect(nodes.at(-1)?.value).toBe(100);
  });

  it("shows a single small leftover by name rather than as Other", () => {
    const nodes = foldSmallItems(
      [{ name: "Wages", value: 9900 }, { name: "Dividends", value: 50 }],
      { maxItems: 7, pool: 10000, otherLabel: OTHER_INCOME_LABEL, kind: "income" },
    );
    expect(nodes.map((n) => n.name)).toEqual(["Wages", "Dividends"]);
  });

  it("never returns more than maxItems nodes, Other included, and sorts largest first", () => {
    const items = Array.from({ length: 12 }, (_, i) => ({ name: `I${i}`, value: 100 + i }));
    const nodes = foldSmallItems(items, { maxItems: 7, pool: 2000, otherLabel: OTHER_INCOME_LABEL, kind: "income" });
    expect(nodes).toHaveLength(7);
    expect(nodes[0].name).toBe("I11");
    expect(sum(nodes)).toBe(sum(items));
  });
});

describe("Reports page feeds every category to the chart", () => {
  it("no longer cuts expenses to the top 10 before the chart sees them", () => {
    const src = readFileSync(join(__dirname, "..", "src", "app", "(app)", "reports", "page.tsx"), "utf8");
    const block = src.slice(src.indexOf("const sankeyExpenses"), src.indexOf("const groupItems"));
    expect(block).not.toMatch(/\.slice\(/);
  });
});
