/**
 * @vitest-environment jsdom
 *
 * Weekly Recap (2026-10-23, in-app feedback from martin1194): with HK$ amounts
 * the three summary figures sat in fixed thirds, so "HK$8,180.00" ran into the
 * Income figure and Net Flow broke after its minus sign and was cut off at the
 * card edge. The figures now keep one line each and wrap as whole items.
 * jsdom has no layout, so this pins the classes that make that happen.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { render, screen, cleanup } from "@testing-library/react";
import { WeeklyRecap } from "@/app/(app)/dashboard/_components/weekly-recap";
import type { WeeklyRecapData } from "@/app/(app)/dashboard/_components/types";

vi.mock("@/components/currency-provider", () => ({
  useDisplayCurrency: () => ({ displayCurrency: "HKD", setDisplayCurrency: async () => {} }),
}));

const recap: WeeklyRecapData = {
  weekStart: "2026-10-11",
  weekEnd: "2026-10-17",
  spending: { total: 8180, previousWeekTotal: 10225, changePercent: -20, topCategories: [] },
  income: { total: 0, previousWeekTotal: 0 },
  netCashFlow: -8180,
  budgetStatus: [],
  notableTransactions: [],
  upcomingBills: [],
  netWorthChange: 0,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("WeeklyRecap summary", () => {
  it("keeps each figure on one line and lets the row wrap", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => recap })));
    render(<WeeklyRecap />);

    const spent = await screen.findByText("HK$8,180.00");
    const netFlow = screen.getByText("-HK$8,180.00");
    const income = screen.getByText("HK$0.00");

    for (const figure of [spent, income, netFlow]) {
      expect(figure.className).toContain("whitespace-nowrap");
      expect(figure.parentElement?.className).toContain("grow");
    }

    const row = spent.parentElement?.parentElement;
    expect(row?.className).toContain("flex-wrap");
    expect(row?.className).not.toContain("grid-cols-3");
  });
});
