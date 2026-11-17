/** Reports → Cash Flow: income sources → one pool → spending + surplus/deficit. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  buildCashFlowColumns,
  foldSmallItems,
  groupKey,
  hasGroups,
  UNGROUPED_LABEL,
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
    expect(c.uses.at(-1)).toMatchObject({ name: SURPLUS_LABEL, value: 2400, kind: "surplus" });
    expect(c.sources.some((n) => n.kind === "deficit")).toBe(false);
    expect(sum(c.sources)).toBeCloseTo(c.pool);
    expect(sum(c.uses)).toBeCloseTo(c.pool);
  });

  it("adds a Deficit node on the left when spending beats income", () => {
    const c = buildCashFlowColumns([{ name: "Wages", value: 1000 }], [{ name: "Rent", value: 1500 }]);
    expect(c.pool).toBe(1500);
    expect(c.deficit).toBe(500);
    expect(c.sources.at(-1)).toMatchObject({ name: DEFICIT_LABEL, value: 500, kind: "deficit" });
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
    expect(spending.at(-1)).toMatchObject({ name: OTHER_SPENDING_LABEL, value: 600, kind: "other" });
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

describe("group level", () => {
  const expenses = [
    { name: "Groceries", value: 600, group: "Food" },
    { name: "Dining", value: 400, group: "Food" },
    { name: "Rent", value: 1500, group: "Housing" },
    { name: "Gift", value: 100, group: null },
  ];
  const income = [{ name: "Salary", value: 5000, group: "Work" }];

  it("shows one node per group, with how many categories it holds", () => {
    const c = buildCashFlowColumns(income, expenses, { level: "group" });
    const spend = c.uses.filter((n) => n.kind !== "surplus");
    expect(spend.map((n) => [n.name, n.value, n.role, n.childCount])).toEqual([
      ["Housing", 1500, "group", 1],
      ["Food", 1000, "group", 2],
      [UNGROUPED_LABEL, 100, "group", 1],
    ]);
    expect(c.totalExpenses).toBe(2600);
  });

  it("an expanded group is replaced by its categories, in its place, sharing one colour", () => {
    const c = buildCashFlowColumns(income, expenses, { level: "group", expanded: new Set([groupKey("expense", "Food")]) });
    const spend = c.uses.filter((n) => n.kind !== "surplus");
    expect(spend.map((n) => n.name)).toEqual(["Housing", "Groceries", "Dining", UNGROUPED_LABEL]);
    const food = spend.filter((n) => n.group === "Food");
    expect(food.every((n) => n.role === "child" && n.colourKey === "g:Food")).toBe(true);
    // Totals don't move when a group opens.
    expect(c.surplus).toBe(5000 - 2600);
  });

  it("expanding is per side: the income key doesn't open an expense group of the same name", () => {
    const c = buildCashFlowColumns(income, expenses, { level: "group", expanded: new Set([groupKey("income", "Food")]) });
    expect(c.uses.some((n) => n.role === "child")).toBe(false);
  });

  it("an expanded group is never folded into Other, even when it is small", () => {
    const many = [
      ...Array.from({ length: 12 }, (_, i) => ({ name: `Big${i}`, value: 1000, group: `G${i}` })),
      { name: "Tiny A", value: 5, group: "Small" },
      { name: "Tiny B", value: 5, group: "Small" },
    ];
    const c = buildCashFlowColumns([{ name: "Salary", value: 20000 }], many, {
      level: "group",
      expanded: new Set([groupKey("expense", "Small")]),
    });
    const names = c.uses.map((n) => n.name);
    expect(names).toContain("Tiny A");
    expect(names).toContain("Tiny B");
    expect(names).toContain(OTHER_SPENDING_LABEL);
    expect(c.uses.filter((n) => n.kind !== "surplus").reduce((s, n) => s + n.value, 0)).toBe(12010);
  });

  it("hasGroups is false when no category has a group, so the switch can hide", () => {
    expect(hasGroups([{ name: "A", value: 1 }, { name: "B", value: 2, group: " " }])).toBe(false);
    expect(hasGroups(expenses)).toBe(true);
  });
});

describe("Reports page feeds every category to the chart", () => {
  it("no longer cuts expenses to the top 10 before the chart sees them", () => {
    const src = readFileSync(join(__dirname, "..", "src", "app", "(app)", "reports", "page.tsx"), "utf8");
    const block = src.slice(src.indexOf("const sankeyExpenses"), src.indexOf("const groupItems"));
    expect(block).not.toMatch(/\.slice\(/);
  });
  it("Cash Flow and Year over Year are shown to everyone, not only in Developer mode", () => {
    const src = readFileSync(join(__dirname, "..", "src", "app", "(app)", "reports", "page.tsx"), "utf8");
    expect(src).not.toMatch(/useDevMode|devMode/);
    expect(src).toMatch(/<TabsTrigger value="cashflow">/);
    expect(src).toMatch(/<TabsTrigger value="yoy">/);
  });
});
