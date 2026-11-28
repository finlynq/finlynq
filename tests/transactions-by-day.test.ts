/**
 * GH #465 — the Transactions "By day" view. Pure helpers: grouping a page of
 * rows by day, whole-day totals with the Calendar / Reports money rules, the
 * sort the view asks for, and the header wording.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildDayTotals,
  byDaySort,
  formatDayHeading,
  groupTransactionsByDay,
  signedMoney,
  sumDayTotals,
} from "@/lib/transactions/by-day";

describe("groupTransactionsByDay", () => {
  it("keeps the page's order and starts a group at each new date", () => {
    const rows = [
      { id: 9, date: "2026-11-27" },
      { id: 8, date: "2026-11-27" },
      { id: 7, date: "2026-11-25" },
      { id: 6, date: "2026-11-24" },
      { id: 5, date: "2026-11-24" },
    ];
    expect(groupTransactionsByDay(rows)).toEqual([
      { date: "2026-11-27", rows: [rows[0], rows[1]] },
      { date: "2026-11-25", rows: [rows[2]] },
      { date: "2026-11-24", rows: [rows[3], rows[4]] },
    ]);
  });

  it("returns nothing for an empty page", () => {
    expect(groupTransactionsByDay([])).toEqual([]);
  });
});

describe("buildDayTotals", () => {
  it("counts income (I) and spending (E, refunds netted), never transfers or uncategorized rows", () => {
    const days = buildDayTotals(
      [
        { date: "2026-11-27", categoryType: "I", value: 1200, count: 1 },
        { date: "2026-11-27", categoryType: "E", value: -90.1, count: 4 },
        // A refund in an expense category nets out of spending.
        { date: "2026-11-27", categoryType: "E", value: 6, count: 1 },
        // Transfer legs and an uncategorized trade: counted, not money.
        { date: "2026-11-27", categoryType: "R", value: -500, count: 2 },
        { date: "2026-11-27", categoryType: null, value: -1000, count: 1 },
      ],
      new Map([["2026-11-27", 6]]),
    );
    expect(days).toEqual([{ date: "2026-11-27", income: 1200, spending: 84.1, count: 6 }]);
  });

  it("takes the count from the transactions, so a split transaction counts once", () => {
    // One transaction split into two expense categories = two slices.
    const days = buildDayTotals(
      [
        { date: "2026-11-26", categoryType: "E", value: -20.51, count: 1 },
        { date: "2026-11-26", categoryType: "E", value: -43.34, count: 1 },
      ],
      new Map([["2026-11-26", 1]]),
    );
    expect(days).toEqual([{ date: "2026-11-26", income: 0, spending: 63.85, count: 1 }]);
  });

  it("keeps a day with only transfers (count, zero money) and sorts by date", () => {
    const days = buildDayTotals(
      [
        { date: "2026-11-27", categoryType: "E", value: -5, count: 1 },
        { date: "2026-11-25", categoryType: "R", value: 300, count: 1 },
      ],
      new Map([
        ["2026-11-27", 1],
        ["2026-11-25", 1],
      ]),
    );
    expect(days).toEqual([
      { date: "2026-11-25", income: 0, spending: 0, count: 1 },
      { date: "2026-11-27", income: 0, spending: 5, count: 1 },
    ]);
  });
});

describe("sumDayTotals", () => {
  it("adds the days and rounds to cents", () => {
    expect(
      sumDayTotals([
        { date: "2026-11-27", income: 0.1, spending: 10.005, count: 2 },
        { date: "2026-11-26", income: 0.2, spending: 5, count: 3 },
      ]),
    ).toEqual({ income: 0.3, spending: 15.01, count: 5 });
  });
});

describe("byDaySort", () => {
  it("keeps a date sort in either direction", () => {
    expect(byDaySort({ columnId: "date", direction: "asc" })).toEqual({
      sort: { columnId: "date", direction: "asc" },
      overridden: false,
    });
    expect(byDaySort({ columnId: "date", direction: "desc" }).overridden).toBe(false);
  });

  it("no sort means the server default, newest first, with nothing to explain", () => {
    expect(byDaySort({ columnId: null, direction: null })).toEqual({
      sort: { columnId: null, direction: null },
      overridden: false,
    });
  });

  it("sets aside any other column sort and says so", () => {
    expect(byDaySort({ columnId: "amount", direction: "desc" })).toEqual({
      sort: { columnId: null, direction: null },
      overridden: true,
    });
  });
});

describe("header wording", () => {
  it("spells out the direction of each total", () => {
    expect(signedMoney(1200, "USD")).toBe("+$1,200.00");
    expect(signedMoney(-84.1, "USD")).toBe("−$84.10");
    expect(signedMoney(0, "USD")).toBe("$0.00");
  });

  it("reads the day as a calendar date in every time zone", () => {
    const heading = formatDayHeading("2026-11-27");
    expect(heading).toContain("27");
    expect(heading).toContain("2026");
    expect(heading).toMatch(/Fri/);
  });
});

describe("wiring (static)", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

  it("the list route totals whole days under the same filters, text-filter matches included", () => {
    const route = read("src/app/api/transactions/route.ts");
    expect(route).toContain('params.get("dayTotals") === "1"');
    expect(route).toContain("loadDayTotals(userId, filters, dates, matchedIds)");
  });

  it("day totals come from the list's own SQL filters and the category-flows view", () => {
    const src = read("src/lib/transactions/day-totals.ts");
    expect(src).toContain("getTransactionIdsOnDates(userId, filters, uniqueDates)");
    expect(src).toContain("flowIdIn(");
    expect(src).toContain("convertReportingSlice(");
    expect(read("src/lib/queries.ts")).toMatch(
      /export async function getTransactionIdsOnDates[\s\S]{0,400}buildTxFilterConditions\(userId, filters\)/,
    );
  });
});
