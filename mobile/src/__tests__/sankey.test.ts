import {
  capSankeyExpenses,
  layoutSankey,
  sankeyDesiredWidth,
  truncateLabel,
  type SankeyDatum,
} from "../lib/reports/sankey";

const W = 600;

describe("layoutSankey", () => {
  it("flags empty when there is no income or expense", () => {
    const out = layoutSankey([], [], { width: W });
    expect(out.empty).toBe(true);
    expect(out.incomeNodes).toHaveLength(0);
    expect(out.expenseNodes).toHaveLength(0);
    expect(out.flows).toHaveLength(0);
  });

  it("builds a closed bezier flow per income×expense pair", () => {
    const income: SankeyDatum[] = [{ name: "Salary", value: 5000 }];
    const expenses: SankeyDatum[] = [
      { name: "Rent", value: 2000 },
      { name: "Food", value: 800 },
    ];
    const out = layoutSankey(income, expenses, { width: W });
    expect(out.empty).toBe(false);
    expect(out.incomeNodes).toHaveLength(1);
    expect(out.expenseNodes).toHaveLength(2);
    // 1 income × 2 expenses = 2 flows.
    expect(out.flows).toHaveLength(2);
    for (const f of out.flows) {
      expect(f.d.startsWith("M")).toBe(true);
      expect(f.d.includes("C")).toBe(true);
      expect(f.d.trim().endsWith("Z")).toBe(true);
      expect(f.value).toBeGreaterThan(0);
    }
    expect(out.totalIncome).toBe(5000);
    expect(out.totalExpenses).toBe(2800);
  });

  it("drops non-positive datums before laying out", () => {
    const out = layoutSankey(
      [
        { name: "Salary", value: 5000 },
        { name: "Bad", value: 0 },
        { name: "Neg", value: -10 },
      ],
      [{ name: "Rent", value: 2000 }],
      { width: W }
    );
    expect(out.incomeNodes).toHaveLength(1);
    expect(out.incomeNodes[0].name).toBe("Salary");
  });

  it("scales node heights to the larger of total income / expenses", () => {
    // Income 6000 > expenses 3000 → full income column should fill the band;
    // the single expense node should be ~half the band height.
    const out = layoutSankey(
      [{ name: "Salary", value: 6000 }],
      [{ name: "Rent", value: 3000 }],
      { width: W }
    );
    const incH = out.incomeNodes[0].h;
    const expH = out.expenseNodes[0].h;
    expect(incH).toBeGreaterThan(expH);
    // expense (3000) is half of maxTotal (6000) → ~half the income height.
    expect(expH).toBeCloseTo(incH / 2, 0);
  });

  it("emits a savings bar only when income exceeds expenses", () => {
    const surplus = layoutSankey(
      [{ name: "Salary", value: 5000 }],
      [{ name: "Rent", value: 2000 }],
      { width: W }
    );
    expect(surplus.savings).toBe(3000);
    expect(surplus.savingsBar).not.toBeNull();
    expect(surplus.savingsBar!.w).toBeGreaterThan(0);

    const deficit = layoutSankey(
      [{ name: "Salary", value: 1000 }],
      [{ name: "Rent", value: 2000 }],
      { width: W }
    );
    expect(deficit.savings).toBe(-1000);
    expect(deficit.savingsBar).toBeNull();
  });

  it("keeps expense nodes on the right of income nodes", () => {
    const out = layoutSankey(
      [{ name: "Salary", value: 5000 }],
      [{ name: "Rent", value: 2000 }],
      { width: W }
    );
    expect(out.expenseNodes[0].x).toBeGreaterThan(out.incomeNodes[0].x);
  });

  it("adds no savings source when income covers expenses", () => {
    const out = layoutSankey(
      [{ name: "Salary", value: 5000 }],
      [{ name: "Rent", value: 2000 }],
      { width: W }
    );
    expect(out.shortfall).toBe(0);
    expect(out.incomeNodes.some((n) => n.fromSavings)).toBe(false);
  });

  it("funds a deficit with a 'From savings' source so no income band overflows", () => {
    const income: SankeyDatum[] = [
      { name: "Salary", value: 1000 },
      { name: "Side gig", value: 500 },
    ];
    const expenses: SankeyDatum[] = [
      { name: "Rent", value: 1600 },
      { name: "Food", value: 400 },
    ];
    const out = layoutSankey(income, expenses, { width: W });

    // Real totals are untouched (they must match the screen's summary).
    expect(out.totalIncome).toBe(1500);
    expect(out.totalExpenses).toBe(2000);
    expect(out.savings).toBe(-500);
    expect(out.shortfall).toBe(500);
    expect(out.savingsBar).toBeNull();

    const savingsNode = out.incomeNodes.find((n) => n.fromSavings);
    expect(savingsNode).toBeDefined();
    expect(savingsNode!.name).toBe("From savings");
    expect(savingsNode!.value).toBe(500);

    // Every source sends out exactly its own value — never more (the old
    // layout sent income × expenses/income, overflowing each node).
    for (const node of out.incomeNodes) {
      const sent = out.flows.filter((f) => f.fromName === node.name).reduce((s, f) => s + f.value, 0);
      expect(sent).toBeCloseTo(node.value, 6);
    }
    // And every expense receives exactly its value.
    for (const node of out.expenseNodes) {
      const got = out.flows.filter((f) => f.toName === node.name).reduce((s, f) => s + f.value, 0);
      expect(got).toBeCloseTo(node.value, 6);
    }
    // The whole left column stays inside the drawable band.
    const last = out.incomeNodes[out.incomeNodes.length - 1];
    expect(out.incomeNodes[0].y).toBeGreaterThanOrEqual(0);
    expect(last.y + last.h).toBeLessThanOrEqual(out.height);
  });

  it("draws expenses from savings when there is no income at all", () => {
    const out = layoutSankey([], [{ name: "Rent", value: 800 }], { width: W });
    expect(out.empty).toBe(false);
    expect(out.totalIncome).toBe(0);
    expect(out.incomeNodes).toHaveLength(1);
    expect(out.incomeNodes[0].fromSavings).toBe(true);
    expect(out.flows).toHaveLength(1);
    expect(out.flows[0].value).toBeCloseTo(800, 6);
  });

  it("honours a custom savings source label", () => {
    const out = layoutSankey([{ name: "Salary", value: 100 }], [{ name: "Rent", value: 300 }], {
      width: W,
      savingsSourceLabel: "Savings",
    });
    expect(out.incomeNodes.find((n) => n.fromSavings)?.name).toBe("Savings");
  });
});

describe("capSankeyExpenses", () => {
  const rows = (n: number): SankeyDatum[] =>
    Array.from({ length: n }, (_, i) => ({ name: `Cat ${i + 1}`, value: (n - i) * 10 }));

  it("folds everything past the cap into one 'Other (n)' node carrying the remainder", () => {
    const input = rows(14); // values 140, 130, …, 10
    const { data, foldedCount } = capSankeyExpenses(input, 10);
    expect(data).toHaveLength(11);
    expect(foldedCount).toBe(4);
    const other = data[data.length - 1];
    expect(other.name).toBe("Other (4)");
    expect(other.value).toBe(40 + 30 + 20 + 10);
    // Diagram total == sum of every category (matches the summary).
    const total = data.reduce((s, d) => s + d.value, 0);
    expect(total).toBe(input.reduce((s, d) => s + d.value, 0));
  });

  it("keeps the largest categories, sorted desc", () => {
    const { data } = capSankeyExpenses(
      [
        { name: "Small", value: 1 },
        { name: "Big", value: 100 },
        { name: "Mid", value: 50 },
        { name: "Tiny", value: 0.5 },
      ],
      1
    );
    expect(data.map((d) => d.name)).toEqual(["Big", "Other (3)"]);
    expect(data[1].value).toBe(51.5);
  });

  it("leaves the list alone when it fits", () => {
    const { data, foldedCount } = capSankeyExpenses(rows(10), 10);
    expect(data).toHaveLength(10);
    expect(foldedCount).toBe(0);
  });

  it("shows a single leftover category by name instead of 'Other (1)'", () => {
    const { data, foldedCount } = capSankeyExpenses(rows(11), 10);
    expect(data).toHaveLength(11);
    expect(foldedCount).toBe(0);
    expect(data.some((d) => d.name.startsWith("Other"))).toBe(false);
  });

  it("drops non-positive values before capping", () => {
    const { data } = capSankeyExpenses(
      [
        { name: "Rent", value: 100 },
        { name: "Refund", value: -20 },
        { name: "Zero", value: 0 },
      ],
      10
    );
    expect(data.map((d) => d.name)).toEqual(["Rent"]);
  });

  it("feeds layoutSankey a total equal to every category combined", () => {
    const input = rows(15);
    const { data } = capSankeyExpenses(input, 10);
    const out = layoutSankey([{ name: "Salary", value: 5000 }], data, { width: W });
    expect(out.totalExpenses).toBe(input.reduce((s, d) => s + d.value, 0));
  });
});

describe("sankeyDesiredWidth", () => {
  it("is at least wide enough for both label columns + nodes + a flow band", () => {
    const w = sankeyDesiredWidth({});
    // 2*(96+6) labels + 2*16 nodes + 90 band + 16 padding = 342.
    expect(w).toBeGreaterThanOrEqual(300);
  });
});

describe("truncateLabel", () => {
  it("appends an ellipsis past the max", () => {
    expect(truncateLabel("Groceries and Dining", 8)).toBe("Groceri…");
  });
  it("leaves short labels untouched", () => {
    expect(truncateLabel("Rent", 8)).toBe("Rent");
  });
});
