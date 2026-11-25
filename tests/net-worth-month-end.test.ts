// Dashboard Total Net Worth line (2026-11-24): month-end points of the
// accurate net-worth history, not a running total of transaction amounts
// (which counted investments at the money put in and skipped empty months).

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { monthEndPoints, monthOverMonth } from "@/lib/net-worth-month-end";

const root = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

describe("monthEndPoints", () => {
  it("keeps the last day of each month, ending on the latest (today) point", () => {
    const pts = monthEndPoints([
      { date: "2026-09-29", value: 100 },
      { date: "2026-09-30", value: 110 },
      { date: "2026-10-01", value: 120 },
      { date: "2026-10-31", value: 130 },
      { date: "2026-11-24", value: 3315.68 },
    ]);
    expect(pts).toEqual([
      { month: "2026-09", date: "2026-09-30", value: 110 },
      { month: "2026-10", date: "2026-10-31", value: 130 },
      { month: "2026-11", date: "2026-11-24", value: 3315.68 },
    ]);
  });

  it("drops leading zero days but keeps a later zero", () => {
    const pts = monthEndPoints([
      { date: "2026-01-31", value: 0 },
      { date: "2026-02-28", value: 0 },
      { date: "2026-03-31", value: 50 },
      { date: "2026-04-30", value: 0 },
    ]);
    expect(pts.map((p) => p.month)).toEqual(["2026-03", "2026-04"]);
  });

  it("sorts its input and keeps the newest 12 months", () => {
    const days = [];
    for (let m = 1; m <= 14; m++) {
      const y = m <= 12 ? 2025 : 2026;
      const mm = String(((m - 1) % 12) + 1).padStart(2, "0");
      days.push({ date: `${y}-${mm}-15`, value: m });
    }
    const pts = monthEndPoints(days.reverse());
    expect(pts).toHaveLength(12);
    expect(pts[0].month).toBe("2025-03");
    expect(pts[11]).toEqual({ month: "2026-02", date: "2026-02-15", value: 14 });
  });

  it("returns nothing for an all-zero or empty series", () => {
    expect(monthEndPoints([])).toEqual([]);
    expect(monthEndPoints([{ date: "2026-11-01", value: 0 }])).toEqual([]);
  });
});

describe("monthOverMonth", () => {
  const p = (month: string, value: number) => ({ month, date: `${month}-28`, value });

  it("is the latest point minus last month's end", () => {
    expect(monthOverMonth([p("2026-10", 1000), p("2026-11", 1100)])).toEqual({ change: 100, pct: 10 });
  });

  it("gives no percent when last month was zero or negative", () => {
    expect(monthOverMonth([p("2026-10", -16011), p("2026-11", -14099)])).toEqual({ change: 1912, pct: null });
    expect(monthOverMonth([p("2026-10", 0), p("2026-11", 50)])?.pct).toBeNull();
  });

  it("needs two points", () => {
    expect(monthOverMonth([p("2026-11", 5)])).toBeNull();
  });
});

describe("wiring", () => {
  it("the dashboard hero reads the accurate history, not the ledger running total", () => {
    const page = read("src/app/(app)/dashboard/page.tsx");
    expect(page).toContain("/api/net-worth-history?period=1y&resolution=month");
    expect(page).toContain("monthOverMonth(nwPoints)");
    expect(page).not.toMatch(/netWorthOverTime/);
  });

  it("the history route reduces to month-end points on resolution=month", () => {
    const route = read("src/app/api/net-worth-history/route.ts");
    expect(route).toMatch(/params\.get\("resolution"\) === "month"/);
    expect(route).toMatch(/monthly\s*\?\s*monthEndPoints\(rawSeries\)/);
  });
});
