/**
 * Transactions calendar day buckets (in-app feedback 2026-10-07).
 *
 * The calendar must agree with Reports for the same day, so these pin the
 * Reports flow rules the pure `buildCalendarMonth` encodes, plus a static
 * check that the route feeds it the right slices (a pure test passes whether
 * or not the route converts currency or counts uncategorized rows).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import {
  buildCalendarMonth,
  monthBounds,
  CALENDAR_MONTH_RE,
  CALENDAR_DATE_RE,
  addDays,
  daysInRange,
  weekStart,
  periodRange,
  shiftAnchor,
  rollupByMonth,
} from "@/lib/transactions/calendar";

describe("buildCalendarMonth", () => {
  it("income comes from I categories, spending from E categories (positive)", () => {
    const m = buildCalendarMonth([
      { date: "2026-10-03", categoryType: "I", value: 2500, count: 1 },
      { date: "2026-10-03", categoryType: "E", value: -42.5, count: 2 },
    ]);
    expect(m.days).toEqual([{ date: "2026-10-03", income: 2500, spending: 42.5, count: 3 }]);
  });

  it("a refund in an expense category nets out of spending", () => {
    const m = buildCalendarMonth([
      { date: "2026-10-05", categoryType: "E", value: -100, count: 1 },
      { date: "2026-10-05", categoryType: "E", value: 30, count: 1 },
    ]);
    expect(m.days[0].spending).toBe(70);
  });

  it("transfers and uncategorized rows are counted but are neither income nor spending", () => {
    const m = buildCalendarMonth([
      { date: "2026-10-09", categoryType: "R", value: -500, count: 2 },
      { date: "2026-10-09", categoryType: null, value: -1200, count: 1 },
    ]);
    expect(m.days).toEqual([{ date: "2026-10-09", income: 0, spending: 0, count: 3 }]);
  });

  it("merges a day's currency groups, sorts days, rounds, and totals the month", () => {
    const m = buildCalendarMonth([
      { date: "2026-10-20", categoryType: "E", value: -10.005, count: 1 },
      { date: "2026-10-02", categoryType: "E", value: -0.1, count: 1 },
      { date: "2026-10-02", categoryType: "E", value: -0.2, count: 1 },
      { date: "2026-10-20", categoryType: "I", value: 99.999, count: 1 },
    ]);
    expect(m.days.map((d) => d.date)).toEqual(["2026-10-02", "2026-10-20"]);
    expect(m.days[0].spending).toBe(0.3);
    expect(m.totals).toEqual({ income: 100, spending: 10.31, count: 4 });
  });

  it("an empty month has no days and zero totals", () => {
    expect(buildCalendarMonth([])).toEqual({ days: [], totals: { income: 0, spending: 0, count: 0 } });
  });
});

describe("monthBounds", () => {
  it.each([
    ["2026-10", "2026-10-01", "2026-10-31"],
    ["2026-02", "2026-02-01", "2026-02-28"],
    ["2028-02", "2028-02-01", "2028-02-29"],
    ["2026-12", "2026-12-01", "2026-12-31"],
  ])("%s → %s..%s", (month, start, end) => {
    expect(monthBounds(month)).toEqual({ start, end });
  });

  it("the route's month pattern rejects malformed months", () => {
    expect(CALENDAR_MONTH_RE.test("2026-10")).toBe(true);
    for (const bad of ["2026-13", "2026-1", "26-10", "2026-10-01", ""]) {
      expect(CALENDAR_MONTH_RE.test(bad)).toBe(false);
    }
  });
});

describe("week / month / year periods", () => {
  it("weeks run Sunday to Saturday, across month and year boundaries", () => {
    expect(weekStart("2026-10-07")).toBe("2026-10-04"); // Wednesday
    expect(weekStart("2026-10-04")).toBe("2026-10-04"); // already Sunday
    expect(periodRange("week", "2026-10-01")).toEqual({ start: "2026-09-27", end: "2026-10-03" });
    expect(periodRange("week", "2027-01-01")).toEqual({ start: "2026-12-27", end: "2027-01-02" });
  });

  it("months and years cover the whole period", () => {
    expect(periodRange("month", "2026-02-14")).toEqual({ start: "2026-02-01", end: "2026-02-28" });
    expect(periodRange("year", "2026-10-07")).toEqual({ start: "2026-01-01", end: "2026-12-31" });
  });

  it("shifting never skips a month (Jan 31 + 1 month lands in February)", () => {
    expect(shiftAnchor("month", "2026-01-31", 1)).toBe("2026-02-01");
    expect(shiftAnchor("month", "2026-01-15", -1)).toBe("2025-12-01");
    expect(shiftAnchor("year", "2026-10-07", -1)).toBe("2025-10-01");
    expect(shiftAnchor("week", "2026-12-30", 1)).toBe("2027-01-06");
  });

  it("day arithmetic is UTC-exact", () => {
    expect(addDays("2026-03-08", 1)).toBe("2026-03-09"); // a DST weekend in North America
    expect(daysInRange("2026-01-01", "2026-12-31")).toBe(365);
    expect(daysInRange("2028-01-01", "2028-12-31")).toBe(366);
    expect(daysInRange("2026-10-07", "2026-10-07")).toBe(1);
    expect(CALENDAR_DATE_RE.test("2026-10-07")).toBe(true);
    expect(CALENDAR_DATE_RE.test("2026-10-32")).toBe(false);
  });

  it("rolls days up into month totals for the year view", () => {
    const m = rollupByMonth([
      { date: "2026-07-01", income: 0, spending: 55.35, count: 1 },
      { date: "2026-07-04", income: 0, spending: 115.4, count: 2 },
      { date: "2026-08-02", income: 100.1, spending: 0, count: 1 },
    ]);
    expect(m.get("2026-07")).toEqual({ income: 0, spending: 170.75, count: 3 });
    expect(m.get("2026-08")).toEqual({ income: 100.1, spending: 0, count: 1 });
    expect(m.has("2026-09")).toBe(false);
  });
});

describe("GET /api/transactions/calendar wiring", () => {
  const src = readFileSync(path.resolve(__dirname, "../src/app/api/transactions/calendar/route.ts"), "utf8");

  it("converts every slice to the display currency the Reports way", () => {
    expect(src).toMatch(/convertReportingSlice\(r, displayCurrency, rateMap\)/);
  });

  it("LEFT joins categories so uncategorized rows still count toward the day", () => {
    expect(src).toMatch(/\.leftJoin\(schema\.categories/);
    expect(src).not.toMatch(/\.innerJoin\(schema\.categories/);
  });

  it("groups by date, category type and both currencies", () => {
    expect(src).toMatch(/\.groupBy\(t\.date, schema\.categories\.type, t\.currency, t\.reportingCurrency\)/);
  });

  it("scopes every query to the caller", () => {
    expect(src).toMatch(/eq\(t\.userId, userId\)/);
  });

  it("accepts a start/end range but caps it at a year and rejects a reversed one", () => {
    expect(src).toMatch(/CALENDAR_DATE_RE\.test\(start\)/);
    expect(src).toMatch(/span < 1 \|\| span > MAX_CALENDAR_RANGE_DAYS/);
  });
});
