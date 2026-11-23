/**
 * GH #434: the dashboard hero draws each month's net-worth change, not net
 * worth itself. The issue's example: about $560k falling $15k (2.7%) in a
 * month, which the old sparkline drew as a flat line.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { monthlyChanges } from "@/lib/net-worth-changes";

describe("monthlyChanges", () => {
  it("gives one change per month after the first", () => {
    expect(monthlyChanges([560000, 575000, 560000], ["2026-09", "2026-10", "2026-11"])).toEqual([
      { month: "2026-10", change: 15000 },
      { month: "2026-11", change: -15000 },
    ]);
  });

  it("needs at least two months", () => {
    expect(monthlyChanges([], [])).toEqual([]);
    expect(monthlyChanges([100], ["2026-11"])).toEqual([]);
  });

  it("rounds to cents", () => {
    expect(monthlyChanges([0.1, 0.3], ["a", "b"])[0].change).toBe(0.2);
  });
});

describe("dashboard hero", () => {
  it("uses the change bars, not a dimmed 30px sparkline", () => {
    const src = readFileSync(join(__dirname, "../src/app/(app)/dashboard/page.tsx"), "utf8");
    expect(src).toContain("<NetWorthChangeBars");
    expect(src).not.toMatch(/w-40 h-20 opacity-50/);
  });
});
