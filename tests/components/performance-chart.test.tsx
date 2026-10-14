/**
 * @vitest-environment jsdom
 *
 * Performance chart (2026-10-14, owner request): a Value & cost / Value / Cost
 * switch picks the lines drawn, and the header shows the new money excluded
 * from the returns.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { PerformanceChart } from "@/components/portfolio/PerformanceChart";

const series = [
  { date: "2026-01-01", marketValue: 1000, costBasis: 900, contribution: 0, gapsFilled: false },
  { date: "2026-01-02", marketValue: 1100, costBasis: 1000, contribution: 100, gapsFilled: false },
];

function mockPerformance(netNewMoney: number) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      json: async () => ({
        success: true,
        data: {
          period: "1y",
          accountId: null,
          from: "2025-10-14",
          to: "2026-10-14",
          currency: "CAD",
          series,
          twrr: { period: 0.1, annualized: 0.1, hadContributions: true },
          mwrr: { irr: 0.12, converged: true },
          netNewMoney,
          gapsFilledDays: 0,
        },
      }),
    })),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PerformanceChart", () => {
  it("switches between value and cost, value only, and cost only", async () => {
    mockPerformance(100);
    render(<PerformanceChart accountId={null} />);
    expect(await screen.findByText("Market value and cost basis (CAD)")).toBeTruthy();

    fireEvent.click(screen.getByText("Value"));
    expect(screen.getByText("Market value (CAD)")).toBeTruthy();
    expect(screen.getByText("Value").closest("button")?.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByText("Cost"));
    expect(screen.getByText("Cost basis (CAD)")).toBeTruthy();
  });

  it("shows the new money excluded from the returns", async () => {
    mockPerformance(-6383.5);
    render(<PerformanceChart accountId={null} />);
    expect(await screen.findByText(/Net new money:/)).toBeTruthy();
    expect(screen.getByText(/Net new money:/).textContent).toContain("-C$6,383.50");
  });

  it("says nothing about new money when there was none", async () => {
    mockPerformance(0);
    render(<PerformanceChart accountId={null} />);
    await screen.findByText("Market value and cost basis (CAD)");
    expect(screen.queryByText(/Net new money/)).toBeNull();
  });
});
