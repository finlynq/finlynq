/**
 * @vitest-environment jsdom
 *
 * GH #447: the dashboard's Available to Spend card always showed the last
 * complete month while reading like a live view ("remaining", "Spent so far").
 * It now switches between Last month (worded as a closed month) and This month
 * (so far), and remembers the choice in this browser.
 */

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import React from "react";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { AvailableToSpend } from "@/app/(app)/dashboard/_components/available-to-spend";
import {
  SPEND_MONTH_STORAGE_KEY,
  parseSpendMonthMode,
  splitSpendMonths,
} from "@/lib/dashboard/spend-month";
import { getMonthLabel } from "@/lib/currency";

const october = { month: "2026-10", income: 5000, expenses: 4200 };
const november = { month: "2026-11", income: 1000, expenses: 1500 };

describe("splitSpendMonths", () => {
  it("picks the newest month before the current one and the current month", () => {
    const rows = [{ month: "2026-09", income: 1, expenses: 1 }, october, november];
    expect(splitSpendMonths(rows, "2026-11")).toEqual({ last: october, current: november });
  });

  it("current month with nothing booked yet reads as zeros", () => {
    expect(splitSpendMonths([october], "2026-11")).toEqual({
      last: october,
      current: { month: "2026-11", income: 0, expenses: 0 },
    });
  });

  it("no complete month yet: last is null", () => {
    expect(splitSpendMonths([november], "2026-11").last).toBeNull();
  });

  it("a future-dated month is neither last nor current", () => {
    const rows = [october, november, { month: "2026-12", income: 9, expenses: 9 }];
    expect(splitSpendMonths(rows, "2026-11")).toEqual({ last: october, current: november });
  });

  it("anything stored but 'current' means the default", () => {
    expect(parseSpendMonthMode("current")).toBe("current");
    expect(parseSpendMonthMode("last")).toBe("last");
    expect(parseSpendMonthMode(null)).toBe("last");
    expect(parseSpendMonthMode("bogus")).toBe("last");
  });
});

describe("AvailableToSpend card", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(cleanup);

  it("defaults to last month, worded as a closed month", () => {
    render(<AvailableToSpend last={october} current={november} currency="USD" />);
    expect(screen.getByText(`Left over in ${getMonthLabel("2026-10")}`)).toBeTruthy();
    expect(screen.getByText("Spent")).toBeTruthy();
    expect(screen.getByText("Left over")).toBeTruthy();
    expect(screen.queryByText("Spent so far")).toBeNull();
    expect(screen.getByRole("button", { name: "Last month" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getAllByText("$800.00")).toHaveLength(2);
  });

  it("This month shows the current month so far and is remembered", () => {
    render(<AvailableToSpend last={october} current={november} currency="USD" />);
    fireEvent.click(screen.getByRole("button", { name: "This month" }));
    expect(screen.getByText(`${getMonthLabel("2026-11")} so far`)).toBeTruthy();
    expect(screen.getByText("Spent so far")).toBeTruthy();
    expect(screen.getByText("Remaining")).toBeTruthy();
    expect(screen.getByText("-$500.00")).toBeTruthy();
    expect(window.localStorage.getItem(SPEND_MONTH_STORAGE_KEY)).toBe("current");

    cleanup();
    render(<AvailableToSpend last={october} current={november} currency="USD" />);
    expect(screen.getByText(`${getMonthLabel("2026-11")} so far`)).toBeTruthy();
    expect(screen.getByRole("button", { name: "This month" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("with no complete month yet, shows the current month and no switch", () => {
    render(<AvailableToSpend last={null} current={november} currency="USD" />);
    expect(screen.getByText(`${getMonthLabel("2026-11")} so far`)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Last month" })).toBeNull();
  });
});
