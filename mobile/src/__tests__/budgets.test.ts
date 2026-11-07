import {
  budgetProgressLines,
  budgetRows,
  debtStatusLabel,
  debtView,
  excludedTargets,
  filterCounts,
  findBudgetTarget,
  groupView,
  incomeLineView,
  leftToPlanView,
  monthProgress,
  parseBudgetAmount,
  spendBar,
  spendingLineView,
  visibleLinesFor,
  type BudgetGroup,
  type BudgetLine,
  type BudgetMonth,
  type DebtLine,
} from "../lib/budgets";

const line = (over: Partial<BudgetLine> & { categoryId: number; name: string }): BudgetLine => ({
  key: `c:${over.categoryId}`,
  budgeted: null,
  actual: 0,
  carriedIn: null,
  left: null,
  rollover: false,
  rolloverNegative: "carry",
  average3: 0,
  upcoming: 0,
  status: "unbudgeted",
  ...over,
});

const group = (over: Partial<BudgetGroup> & { key: string; name: string; lines: BudgetLine[] }): BudgetGroup => ({
  byGroup: false,
  rollover: false,
  rolloverNegative: "carry",
  budgeted: null,
  actual: 0,
  carriedIn: null,
  left: null,
  upcoming: 0,
  average3: 0,
  status: "ok",
  ...over,
});

const debt = (over: Partial<DebtLine> = {}): DebtLine => ({
  accountId: 1,
  name: "Loan",
  planned: 400,
  paid: 0,
  principal: 340,
  interest: 60,
  bookedInterest: null,
  dueDates: ["2026-11-20"],
  status: "due",
  source: "schedule",
  loanIds: [1],
  ...over,
});

const month = (over: Partial<BudgetMonth> = {}): BudgetMonth => ({
  month: "2026-11",
  currency: "USD",
  today: "2026-11-05",
  summary: {
    plannedIncome: 0,
    receivedIncome: 0,
    plannedSpending: 0,
    spent: 0,
    plannedDebt: 0,
    paidDebt: 0,
    leftToPlan: 0,
    netCashFlow: 0,
    upcoming: 0,
  },
  counts: { notBudgeted: 0, overspent: 0, withUpcoming: 0 },
  income: [],
  spending: [],
  debt: [],
  excluded: [],
  ...over,
});

describe("monthProgress (mirror of the web's month-view.ts)", () => {
  it("places today in the month", () => {
    expect(monthProgress("2026-11", "2026-11-15")).toEqual({ state: "current", day: 15, days: 30, fraction: 0.5 });
  });

  it("knows February's length", () => {
    expect(monthProgress("2026-02", "2026-02-14").days).toBe(28);
    expect(monthProgress("2028-02", "2028-02-14").days).toBe(29);
  });

  it("treats a past month as gone and a future one as not begun", () => {
    expect(monthProgress("2026-10", "2026-11-05")).toEqual({ state: "past", day: 31, days: 31, fraction: 1 });
    expect(monthProgress("2026-12", "2026-11-05")).toEqual({ state: "future", day: 0, days: 31, fraction: 0 });
  });
});

describe("spendBar (mirror of budget-rows.tsx)", () => {
  it("has no bar with nothing budgeted", () => {
    expect(spendBar({ budgeted: null, carriedIn: null, left: null, status: "unbudgeted" })).toBeNull();
    expect(spendBar({ budgeted: 0, carriedIn: null, left: 0, status: "ok" })).toBeNull();
  });

  it("measures against the budget plus what was carried in", () => {
    expect(spendBar({ budgeted: 100, carriedIn: 50, left: 75, status: "ok" })).toEqual({ value: 75, target: 150, tone: "ok" });
  });

  it("warns at 90% and when the server warns, and goes over with the status", () => {
    expect(spendBar({ budgeted: 100, carriedIn: null, left: 10, status: "ok" })?.tone).toBe("warn");
    expect(spendBar({ budgeted: 100, carriedIn: null, left: 50, status: "warn" })?.tone).toBe("warn");
    expect(spendBar({ budgeted: 100, carriedIn: null, left: -5, status: "over" })?.tone).toBe("over");
  });
});

describe("visibleLinesFor (mirror of budget-rows.tsx)", () => {
  const needs = group({
    key: "g:Needs",
    name: "Needs",
    lines: [
      line({ categoryId: 1, name: "A", status: "over", budgeted: 1, left: -1 }),
      line({ categoryId: 2, name: "B", status: "unbudgeted" }),
      line({ categoryId: 3, name: "C", status: "ok", upcoming: 5, budgeted: 9, left: 9 }),
    ],
  });

  it("shows all lines with no filter", () => {
    expect(visibleLinesFor(needs, "all")).toHaveLength(3);
  });

  it("matches a category group line by line", () => {
    expect(visibleLinesFor(needs, "over")?.map((l) => l.name)).toEqual(["A"]);
    expect(visibleLinesFor(needs, "unbudgeted")?.map((l) => l.name)).toEqual(["B"]);
    expect(visibleLinesFor(needs, "upcoming")?.map((l) => l.name)).toEqual(["C"]);
  });

  it("hides a group with no match", () => {
    expect(visibleLinesFor(group({ key: "g:E", name: "E", lines: [] }), "over")).toBeNull();
  });

  it("matches a one-line group as a whole", () => {
    const fun = group({ key: "g:Fun", name: "Fun", byGroup: true, status: "over", lines: [line({ categoryId: 4, name: "D", status: "ok" })] });
    expect(visibleLinesFor(fun, "over")).toHaveLength(1);
    expect(visibleLinesFor(fun, "unbudgeted")).toBeNull();
  });
});

describe("budgetProgressLines (Home's Budget Progress card)", () => {
  const m = month({
    income: [group({ key: "g:income:Pay", name: "Pay", lines: [line({ categoryId: 1, name: "Salary", budgeted: 5000, left: 5000, status: "expected" })] })],
    debt: [debt()],
    spending: [
      group({
        key: "g:Needs",
        name: "Needs",
        lines: [
          line({ categoryId: 2, name: "Groceries", budgeted: 500, actual: 350, left: 150, status: "ok" }),
          line({ categoryId: 3, name: "Transport", actual: 80 }),
          line({ categoryId: 4, name: "Repairs", rollover: true, carriedIn: 400, actual: 100, left: 300, status: "ok" }),
          line({ categoryId: 5, name: "Gifts", budgeted: 0, actual: 20, left: -20, status: "over" }),
        ],
      }),
      group({
        key: "g:Fun",
        name: "Fun",
        byGroup: true,
        budgeted: 200,
        actual: 250,
        left: -50,
        status: "over",
        lines: [line({ categoryId: 6, name: "Movies", actual: 250, status: "ok" })],
      }),
      group({ key: "g:", name: "Other", byGroup: true, lines: [line({ categoryId: 7, name: "Misc", actual: 5, status: "ok" })] }),
    ],
  });

  it("lists what carries a budget: one-line groups whole, other categories with a budget or rollover", () => {
    expect(budgetProgressLines(m).map((l) => l.name).sort()).toEqual(["Fun", "Gifts", "Groceries", "Repairs"]);
  });

  it("uses the server's figures, budget plus carried in as what is available", () => {
    const byName = Object.fromEntries(budgetProgressLines(m).map((l) => [l.name, l]));
    expect(byName.Fun).toEqual({ key: "g:Fun", name: "Fun", spent: 250, available: 200, status: "over" });
    expect(byName.Repairs).toMatchObject({ spent: 100, available: 400, status: "ok" });
  });

  it("puts the most at risk first: anything spent against nothing, then by share used, ties in server order", () => {
    expect(budgetProgressLines(m).map((l) => l.name)).toEqual(["Gifts", "Fun", "Groceries", "Repairs"]);
    const tie = month({
      spending: [
        group({
          key: "g:A",
          name: "A",
          lines: [
            line({ categoryId: 1, name: "First", budgeted: 100, actual: 10, left: 90, status: "ok" }),
            line({ categoryId: 2, name: "Second", budgeted: 100, actual: 10, left: 90, status: "ok" }),
            line({ categoryId: 3, name: "Unused", budgeted: 0, actual: 0, left: 0, status: "ok" }),
          ],
        }),
      ],
    });
    expect(budgetProgressLines(tie).map((l) => l.name)).toEqual(["First", "Second", "Unused"]);
  });

  it("is empty with no spending budgets", () => {
    expect(budgetProgressLines(month())).toEqual([]);
  });
});

describe("filterCounts", () => {
  it("adds income lines with no expected amount to the server's spending count", () => {
    const m = month({
      counts: { notBudgeted: 2, overspent: 1, withUpcoming: 3 },
      income: [
        group({
          key: "g:income:Pay",
          name: "Pay",
          lines: [line({ categoryId: 1, name: "Salary", budgeted: 5, status: "expected" }), line({ categoryId: 2, name: "Bonus" })],
        }),
      ],
    });
    expect(filterCounts(m)).toEqual({ unbudgeted: 3, over: 1, upcoming: 3 });
  });
});

describe("budgetRows", () => {
  const kinds = (m: BudgetMonth, filter: Parameters<typeof budgetRows>[1] = "all", collapsed: string[] = []) =>
    budgetRows(m, filter, new Set(collapsed), false).map((r) => r.kind);

  it("orders income, debt, spending as the web page does", () => {
    const m = month({
      income: [group({ key: "g:income:Pay", name: "Pay", lines: [line({ categoryId: 1, name: "Salary" })] })],
      debt: [debt()],
      spending: [group({ key: "g:Needs", name: "Needs", lines: [line({ categoryId: 2, name: "Food" })] })],
    });
    const rows = budgetRows(m, "all", new Set(), false);
    expect(rows.filter((r) => r.kind === "section").map((r) => (r.kind === "section" ? r.section : ""))).toEqual([
      "income",
      "debt",
      "spending",
    ]);
    // One income group needs no heading of its own.
    expect(kinds(m)).toEqual(["summary", "section", "line", "section", "debt", "debtNote", "section", "group", "line"]);
  });

  it("heads each income group when there are several", () => {
    const m = month({
      income: [
        group({ key: "g:income:Pay", name: "Pay", lines: [line({ categoryId: 1, name: "Salary" })] }),
        group({ key: "g:income:Other", name: "Other", lines: [line({ categoryId: 2, name: "Gifts" })] }),
      ],
    });
    expect(kinds(m)).toEqual(["summary", "section", "group", "line", "group", "line"]);
  });

  it("rounds each block's corners", () => {
    const m = month({
      spending: [
        group({ key: "g:A", name: "A", lines: [line({ categoryId: 1, name: "One" }), line({ categoryId: 2, name: "Two" })] }),
        group({ key: "g:B", name: "B", lines: [] }),
      ],
    });
    const blocks = budgetRows(m, "all", new Set(), false).flatMap((r) =>
      r.kind === "group" || r.kind === "line" ? [[r.first, r.last]] : [],
    );
    expect(blocks).toEqual([
      [true, false],
      [false, false],
      [false, true],
      [true, true],
    ]);
  });

  it("collapses sections and groups, and keeps the header", () => {
    const m = month({
      debt: [debt()],
      spending: [group({ key: "g:A", name: "A", lines: [line({ categoryId: 1, name: "One" })] })],
    });
    expect(kinds(m, "all", ["section:debt"])).toEqual(["summary", "section", "section", "group", "line"]);
    expect(kinds(m, "all", ["g:A"])).toEqual(["summary", "section", "debt", "debtNote", "section", "group"]);
    expect(kinds(m, "all", ["section:spending"])).toEqual(["summary", "section", "debt", "debtNote", "section"]);
  });

  it("a filter opens what is collapsed and leaves debt and the left-out list out", () => {
    const m = month({
      debt: [debt()],
      spending: [group({ key: "g:A", name: "A", lines: [line({ categoryId: 1, name: "One" })] })],
      excluded: [{ key: "c:9", categoryId: 9, name: "X", group: "G", type: "E", by: "category" }],
    });
    const rows = budgetRows(m, "unbudgeted", new Set(["g:A", "section:spending"]), true);
    expect(rows.map((r) => r.kind)).toEqual(["summary", "section", "group", "line"]);
    for (const r of rows) if (r.kind === "section" || r.kind === "group") expect(r.collapsible).toBe(false);
  });

  it("says when there is nothing to list", () => {
    expect(budgetRows(month(), "all", new Set(), false)[1]).toEqual({ kind: "empty", message: "No income or expense categories yet." });
    expect(budgetRows(month(), "over", new Set(), false)[1]).toEqual({ kind: "empty", message: "Nothing to show for this filter this month." });
  });

  it("lists what is left out only when asked", () => {
    const m = month({ excluded: [{ key: "c:9", categoryId: 9, name: "X", group: "G", type: "E", by: "category" }] });
    expect(budgetRows(m, "all", new Set(), false).map((r) => r.kind)).toEqual(["summary", "empty", "excludedToggle"]);
    expect(budgetRows(m, "all", new Set(), true).map((r) => r.kind)).toEqual(["summary", "empty", "excludedToggle", "excluded"]);
  });
});

describe("excludedTargets", () => {
  it("brings a whole group back as one and labels the blank group Other", () => {
    const m = month({
      excluded: [
        { key: "c:1", categoryId: 1, name: "A", group: "Work", type: "E", by: "group" },
        { key: "c:2", categoryId: 2, name: "B", group: "Work", type: "E", by: "group" },
        { key: "c:3", categoryId: 3, name: "C", group: "", type: "E", by: "group" },
        { key: "c:4", categoryId: 4, name: "D", group: "", type: "E", by: "category" },
        { key: "c:5", categoryId: 5, name: "E", group: "Pay", type: "I", by: "category" },
      ],
    });
    expect(excludedTargets(m)).toEqual([
      { key: "group:Work", label: "Work", note: "Whole group", target: { group: "Work" } },
      { key: "group:", label: "Other", note: "Whole group", target: { group: "" } },
      { key: "c:4", label: "D", note: "Other", target: { categoryId: 4 } },
      { key: "c:5", label: "E", note: "Income", target: { categoryId: 5 } },
    ]);
  });
});

describe("findBudgetTarget", () => {
  const m = month({
    income: [group({ key: "g:income:Pay", name: "Pay", lines: [line({ categoryId: 1, name: "Salary" })] })],
    spending: [
      group({ key: "g:Needs", name: "Needs", lines: [line({ categoryId: 2, name: "Food", budgeted: 10, left: 10, status: "ok" })] }),
      group({ key: "g:", name: "Other", byGroup: true, budgeted: 40, lines: [line({ categoryId: 3, name: "Misc", status: "ok" })] }),
    ],
  });

  it("finds a category line", () => {
    expect(findBudgetTarget(m, "c:2")).toMatchObject({ section: "spending", categoryId: 2, group: null, inGroupBudget: false, budgeted: 10 });
    expect(findBudgetTarget(m, "c:1")).toMatchObject({ section: "income", categoryId: 1 });
  });

  it("keeps a one-line group's stored name apart from its label", () => {
    expect(findBudgetTarget(m, "g:")).toMatchObject({ name: "Other", group: "", categoryId: null, budgeted: 40 });
  });

  it("marks a category inside a one-line group", () => {
    expect(findBudgetTarget(m, "c:3")).toMatchObject({ inGroupBudget: true, categoryId: 3 });
  });

  it("does not offer an ordinary group's heading as a budget", () => {
    expect(findBudgetTarget(m, "g:Needs")).toBeNull();
  });

  it("is null once the line has gone", () => {
    expect(findBudgetTarget(m, "c:99")).toBeNull();
  });
});

describe("parseBudgetAmount", () => {
  it("reads numbers, with commas as thousands", () => {
    expect(parseBudgetAmount("500")).toBe(500);
    expect(parseBudgetAmount(" 1,250.50 ")).toBe(1250.5);
    expect(parseBudgetAmount("0")).toBe(0);
  });

  it("reads a decimal comma from a phone's keypad, never as thousands", () => {
    expect(parseBudgetAmount("12,50")).toBe(12.5);
    expect(parseBudgetAmount("12,5")).toBe(12.5);
    expect(parseBudgetAmount("1.250,50")).toBe(1250.5);
    expect(parseBudgetAmount("1,250")).toBe(1250);
    expect(parseBudgetAmount("1,250,000")).toBe(1250000);
  });

  it("reads empty as no budget", () => {
    expect(parseBudgetAmount("")).toBeNull();
    expect(parseBudgetAmount("   ")).toBeNull();
  });

  it("refuses anything else", () => {
    for (const bad of ["-1", "abc", "1.2.3", "Infinity"]) expect(parseBudgetAmount(bad)).toBe("invalid");
  });
});

describe("leftToPlanView", () => {
  const fmt = (n: number) => `$${n}`;

  it("asks for expected income first", () => {
    const v = leftToPlanView({ plannedIncome: 0, leftToPlan: -500 });
    expect(v.amount).toBeNull();
    expect(v.sentence(fmt)).toMatch(/Set expected income/);
  });

  it("says how much is unplanned", () => {
    const v = leftToPlanView({ plannedIncome: 5000, leftToPlan: 1600 });
    expect(v).toMatchObject({ label: "Left to plan", amount: 1600, tone: "ok" });
    expect(v.sentence(fmt)).toBe("Not planned yet, of the $5000 you expect.");
  });

  it("says when every dollar is planned", () => {
    expect(leftToPlanView({ plannedIncome: 5000, leftToPlan: 0 }).sentence(fmt)).toMatch(/Every dollar/);
  });

  it("names an over-planned month, as a positive amount", () => {
    expect(leftToPlanView({ plannedIncome: 5000, leftToPlan: -200 })).toMatchObject({ label: "Over-planned", amount: 200, tone: "over" });
  });
});

describe("row wording", () => {
  it("a budgeted line says what is left", () => {
    const v = spendingLineView(line({ categoryId: 1, name: "A", budgeted: 500, actual: 350, left: 150, status: "ok" }), "USD");
    expect(v).toMatchObject({ right: "$150.00 left", tone: "ok", meta: "$350.00 of $500.00" });
    expect(v.bar).toEqual({ value: 350, target: 500, tone: "ok" });
  });

  it("an overspent line says how far over, never a negative left", () => {
    const v = spendingLineView(line({ categoryId: 1, name: "A", budgeted: 200, actual: 250, left: -50, status: "over" }), "USD");
    expect(v).toMatchObject({ right: "$50.00 over", tone: "over" });
  });

  it("a line with no budget says so and flags its spending", () => {
    expect(spendingLineView(line({ categoryId: 1, name: "A", actual: 20, average3: 15.4 }), "USD")).toEqual({
      right: "Not budgeted",
      tone: "warn",
      meta: "$20.00 spent · avg $15",
      bar: null,
    });
    // Nothing to say under the name: the row is one line.
    expect(spendingLineView(line({ categoryId: 1, name: "A" }), "USD")).toEqual({ right: "Not budgeted", tone: "muted", meta: null, bar: null });
  });

  it("a rollover line with no budget this month still has a left", () => {
    const v = spendingLineView(line({ categoryId: 1, name: "A", rollover: true, carriedIn: 40, actual: 10, left: 30, status: "ok" }), "USD");
    expect(v.right).toBe("$30.00 left");
    expect(v.meta).toBe("$10.00 spent · carried in $40.00");
  });

  it("income says what is to come, or that it came", () => {
    expect(incomeLineView(line({ categoryId: 1, name: "A", budgeted: 100, actual: 40, left: 60, status: "expected" }), "USD").right).toBe("$60.00 to come");
    expect(incomeLineView(line({ categoryId: 1, name: "A", budgeted: 100, actual: 120, left: -20, status: "received" }), "USD").right).toBe("Received");
    expect(incomeLineView(line({ categoryId: 1, name: "A", actual: 40 }), "USD")).toMatchObject({ right: "Not budgeted", meta: "$40.00 received" });
  });

  it("an ordinary group names its two amounts, since left only counts budgeted lines", () => {
    const g = group({ key: "g:A", name: "A", budgeted: 500, actual: 900, left: 100, lines: [] });
    expect(groupView(g, "spending", "USD")).toMatchObject({ right: "$100.00 left", meta: "$900.00 spent · $500.00 budgeted" });
  });

  it("a one-line group reads like a budgeted line", () => {
    const g = group({ key: "g:A", name: "A", byGroup: true, budgeted: 500, actual: 350, left: 150, lines: [] });
    expect(groupView(g, "spending", "USD")).toMatchObject({ right: "$150.00 left", meta: "$350.00 of $500.00" });
  });

  it("a debt line follows its status", () => {
    expect(debtStatusLabel(debt({ status: "due", dueDates: ["2026-11-03", "2026-11-20"] }), "2026-11-05")).toBe("Due 11-20");
    expect(debtStatusLabel(debt({ status: "paid" }), "2026-11-05")).toBe("Paid");
    expect(debtStatusLabel(debt({ status: "late" }), "2026-11-05")).toBe("Late");
    expect(debtStatusLabel(debt({ status: "none" }), "2026-11-05")).toBe("Nothing due");
    expect(debtView(debt({ status: "late", paid: 100 }), "2026-11-05", "USD")).toEqual({
      right: "Late",
      tone: "over",
      meta: "$100.00 of $400.00 · $60.00 interest",
      bar: { value: 100, target: 400, tone: "over" },
    });
    expect(debtView(debt({ status: "none", planned: 0, source: "none" }), "2026-11-05", "USD")).toMatchObject({
      right: "Nothing due",
      tone: "muted",
      meta: "No payment scheduled this month",
      bar: null,
    });
  });
});
