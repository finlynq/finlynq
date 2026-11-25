// Dashboard Budgets card + spending sign (2026-11-25).
//
// The card showed income minus spending under a "Budgets" label, and the
// dashboard took Math.abs of each month's expense total, so a month whose
// refunds outweighed its purchases (dev demo, Nov 2026: +1,560.70) read as
// 1,560.70 spent and the card said "Over budget" with no budget set.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { budgetCardMonth, budgetCardView } from "@/lib/dashboard/budget-card";

const fmt = (n: number) => `$${n.toFixed(2)}`;
const page = readFileSync(path.resolve(__dirname, "..", "src/app/(app)/dashboard/page.tsx"), "utf8");

describe("budgetCardMonth", () => {
  it("is this month or the calendar month before it", () => {
    expect(budgetCardMonth("2026-11", "current")).toBe("2026-11");
    expect(budgetCardMonth("2026-11", "last")).toBe("2026-10");
    expect(budgetCardMonth("2026-01", "last")).toBe("2025-12");
  });
});

describe("budgetCardView", () => {
  it("is planned spending minus spent, like the Budgets page", () => {
    expect(budgetCardView({ plannedSpending: 500, spent: 120.5 }, true, fmt)).toEqual({
      value: 379.5,
      sub: "Left to spend · $500.00 budgeted",
    });
  });

  it("net refunds (negative spent) add to what is left", () => {
    expect(budgetCardView({ plannedSpending: 267.35, spent: -895.38 }, true, fmt).value).toBe(1162.73);
  });

  it("words over-budget and closed months", () => {
    expect(budgetCardView({ plannedSpending: 100, spent: 150 }, true, fmt)).toEqual({
      value: -50,
      sub: "Over budget · $100.00 budgeted",
    });
    expect(budgetCardView({ plannedSpending: 100, spent: 150 }, false, fmt).sub).toMatch(/^Overspent/);
    expect(budgetCardView({ plannedSpending: 100, spent: 40 }, false, fmt).sub).toMatch(/^Left over/);
  });

  it("never says over budget when nothing is budgeted", () => {
    expect(budgetCardView({ plannedSpending: 0, spent: 1560.7 }, true, fmt)).toEqual({
      value: 0,
      sub: "No spending budget set",
    });
  });

  it("shows loading and failure states", () => {
    expect(budgetCardView(undefined, true, fmt).sub).toBe("Loading…");
    expect(budgetCardView(null, true, fmt).sub).toBe("Couldn't load your budget");
  });
});

describe("dashboard wiring", () => {
  it("negates the expense total instead of taking its absolute value", () => {
    expect(page).toMatch(/entry\.expenses = -row\.total/);
    expect(page).not.toMatch(/entry\.expenses = Math\.abs/);
  });

  it("the Budgets card reads the budget month, not income minus spending", () => {
    expect(page).toContain("/api/budgets/month?month=${budgetMonthKey}");
    expect(page).toMatch(/value: budgetsView\.value/);
    expect(page).not.toMatch(/budgetLeft/);
  });
});
