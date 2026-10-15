import {
  HEAT_LEVELS,
  expectedForMonth,
  expectedTotals,
  heatColor,
  maxDailySpending,
  shiftMonthKey,
  spendingLevel,
  transactionCountLabel,
} from "../lib/home-calendar";

describe("spending shades", () => {
  it("finds the month's biggest spending day", () => {
    expect(maxDailySpending([{ spending: 40 }, { spending: 120 }, { spending: 0 }])).toBe(120);
    expect(maxDailySpending([])).toBe(0);
  });

  it("a day with nothing spent has no shade", () => {
    expect(spendingLevel(0, 120)).toBe(0);
    expect(spendingLevel(-5, 120)).toBe(0);
    expect(spendingLevel(10, 0)).toBe(0);
    expect(spendingLevel(NaN, 120)).toBe(0);
  });

  it("the biggest day gets the deepest shade", () => {
    expect(spendingLevel(120, 120)).toBe(HEAT_LEVELS);
  });

  // One large bill must not wash every other day out to the palest shade.
  it("uses a square-root scale, so ordinary days still tell apart", () => {
    expect(spendingLevel(30, 120)).toBe(2); // a quarter of the biggest day
    expect(spendingLevel(60, 120)).toBe(3); // half
    expect(spendingLevel(1, 120)).toBe(1); // any spending at all shows
  });

  it("turns a level into the spending colour with transparency", () => {
    expect(heatColor("#db4f3f", 0)).toBeUndefined();
    expect(heatColor("#db4f3f", 1)).toBe("#db4f3f24");
    expect(heatColor("#db4f3f", HEAT_LEVELS)).toBe("#db4f3fB0");
    expect(heatColor("#db4f3f", 9)).toBe("#db4f3fB0");
  });

  it("gives no shade rather than a wrong one for a colour it cannot extend", () => {
    expect(heatColor("rgb(219, 79, 63)", 2)).toBeUndefined();
    expect(heatColor("#fff", 2)).toBeUndefined();
  });
});

describe("small helpers", () => {
  it("counts transactions in words", () => {
    expect(transactionCountLabel(1)).toBe("1 transaction");
    expect(transactionCountLabel(3)).toBe("3 transactions");
  });

  it("moves a month across year boundaries", () => {
    expect(shiftMonthKey("2026-10", 1)).toBe("2026-11");
    expect(shiftMonthKey("2026-12", 1)).toBe("2027-01");
    expect(shiftMonthKey("2026-01", -1)).toBe("2025-12");
    expect(shiftMonthKey("2026-03", -14)).toBe("2025-01");
  });
});

describe("expected payments on the Home calendar", () => {
  const sub = {
    id: 1,
    name: "Rent",
    amount: 1200,
    currency: "USD",
    frequency: "monthly",
    nextDate: "2026-10-01",
    status: "active",
    displayAmount: 1200,
  };

  it("keeps only the days after today", () => {
    const m = expectedForMonth([{ ...sub, nextDate: "2026-10-15" }, { ...sub, id: 2, name: "Phone", nextDate: "2026-10-16" }], [], "2026-10", "2026-10-15");
    expect([...m.keys()]).toEqual(["2026-10-16"]);
  });

  it("is empty for a month already over, and whole for one to come", () => {
    expect(expectedForMonth([sub], [], "2026-09", "2026-10-15").size).toBe(0);
    expect([...expectedForMonth([sub], [], "2026-11", "2026-10-15").keys()]).toEqual(["2026-11-01"]);
  });

  it("sums bills and income apart, in the display currency", () => {
    const recurring = [
      {
        payee: "Employer",
        avgAmount: 3000,
        currency: "EUR",
        avgAmountDisplay: 3300,
        frequency: "monthly",
        count: 4,
        lastDate: "2026-10-01",
        nextDate: "2026-11-01",
        accountId: 1,
        categoryId: null,
      },
    ];
    const totals = expectedTotals(expectedForMonth([sub], recurring, "2026-11", "2026-10-15"));
    expect(totals).toEqual({ bills: 1200, income: 3300, count: 2 });
  });
});

