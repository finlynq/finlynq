/**
 * @vitest-environment jsdom
 *
 * GH #447: the dashboard's Available to Spend card always showed the last
 * complete month while reading like a live view ("remaining", "Spent so far").
 * It now switches between Last month (worded as a closed month) and This month
 * (so far), and remembers the choice in this browser.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import React from "react";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { AvailableToSpend } from "@/app/(app)/dashboard/_components/available-to-spend";
import { StatCard } from "@/app/(app)/dashboard/_components/stat-card";
import { useSpendMonthMode } from "@/app/(app)/dashboard/_components/month-switch";
import { TrendingUp } from "lucide-react";
import type { SpendMonthFigures } from "@/lib/dashboard/spend-month";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
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

/** The dashboard's wiring: one shared choice for the card and a stat tile. */
function Harness({ last, current, withTile = false }: { last: SpendMonthFigures | null; current: SpendMonthFigures; withTile?: boolean }) {
  const [mode, toggle] = useSpendMonthMode();
  const showingCurrent = mode === "current" || !last;
  const fig = showingCurrent ? current : last!;
  return (
    <>
      <AvailableToSpend last={last} current={current} mode={mode} onToggleMode={toggle} currency="USD" />
      {withTile && (
        <StatCard
          label="Monthly Income"
          value={fig.income}
          sub={fig.month}
          icon={TrendingUp}
          iconBg=""
          sparkColor="#10b981"
          sparkData={[1, 2]}
          href="/transactions"
          currency="USD"
          monthSwitch={last ? { showingCurrent, onToggle: toggle } : undefined}
        />
      )}
    </>
  );
}

describe("AvailableToSpend card", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(cleanup);

  const shown = () => screen.getAllByTestId("spend-month-shown").map((e) => e.textContent);

  it("defaults to last month, worded as a closed month", () => {
    render(<Harness last={october} current={november} />);
    expect(screen.getByText(`Left over in ${getMonthLabel("2026-10")}`)).toBeTruthy();
    expect(screen.getByText("Spent")).toBeTruthy();
    expect(screen.getByText("Left over")).toBeTruthy();
    expect(screen.queryByText("Spent so far")).toBeNull();
    expect(shown()).toEqual(["Last month"]);
    expect(screen.getByRole("button", { name: "Show this month" })).toBeTruthy();
    expect(screen.getAllByText("$800.00")).toHaveLength(2);
  });

  it("the icon switches to this month, the text says so, and it is remembered", () => {
    render(<Harness last={october} current={november} />);
    fireEvent.click(screen.getByRole("button", { name: "Show this month" }));
    expect(shown()).toEqual(["This month"]);
    expect(screen.getByText(`${getMonthLabel("2026-11")} so far`)).toBeTruthy();
    expect(screen.getByText("Spent so far")).toBeTruthy();
    expect(screen.getByText("Remaining")).toBeTruthy();
    expect(screen.getByText("-$500.00")).toBeTruthy();
    expect(window.localStorage.getItem(SPEND_MONTH_STORAGE_KEY)).toBe("current");

    cleanup();
    render(<Harness last={october} current={november} />);
    expect(shown()).toEqual(["This month"]);

    // ...and back again.
    fireEvent.click(screen.getByRole("button", { name: "Show last month" }));
    expect(shown()).toEqual(["Last month"]);
    expect(window.localStorage.getItem(SPEND_MONTH_STORAGE_KEY)).toBe("last");
  });

  it("the switch is a small icon button with the month shown next to it; the header wraps on a narrow card", () => {
    render(<Harness last={october} current={november} />);
    const button = screen.getByRole("button", { name: "Show this month" });
    expect(button.className.split(/\s+/)).toContain("size-6");
    expect(button.textContent).toBe("");
    expect(button.querySelector("svg")).toBeTruthy();
    expect(button.nextElementSibling?.textContent).toBe("Last month");
    expect(button.parentElement!.parentElement!.className).toContain("flex-wrap");
  });

  it("with no complete month yet, shows the current month and no switch", () => {
    render(<Harness last={null} current={november} withTile />);
    expect(screen.getByText(`${getMonthLabel("2026-11")} so far`)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByTestId("spend-month-shown")).toBeNull();
  });
});

describe("stat tiles share the switch (Income, Expenses, Budgets)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    push.mockClear();
  });
  afterEach(cleanup);

  it("the tile's switch flips every card together", () => {
    render(<Harness last={october} current={november} withTile />);
    expect(screen.getAllByTestId("spend-month-shown").map((e) => e.textContent)).toEqual(["Last month", "Last month"]);
    expect(screen.getByText("2026-10")).toBeTruthy();

    const tileSwitch = screen.getAllByRole("button", { name: "Show this month" })[1];
    fireEvent.click(tileSwitch);
    expect(screen.getAllByTestId("spend-month-shown").map((e) => e.textContent)).toEqual(["This month", "This month"]);
    expect(screen.getByText("2026-11")).toBeTruthy();
    expect(screen.getByText(`${getMonthLabel("2026-11")} so far`)).toBeTruthy();
    // Toggling does not navigate away.
    expect(push).not.toHaveBeenCalled();
  });

  it("the tile still opens its page, and its switch is not inside the link", () => {
    render(<Harness last={october} current={november} withTile />);
    const link = screen.getByRole("link", { name: "Monthly Income" });
    expect(link.getAttribute("href")).toBe("/transactions");
    const tileSwitch = screen.getAllByRole("button", { name: "Show this month" })[1];
    expect(link.contains(tileSwitch)).toBe(false);
  });
});

describe("dashboard wiring", () => {
  it("drops the small Net Worth tile and gives the tiles the shared switch", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "..", "..", "src/app/(app)/dashboard/page.tsx"), "utf8");
    expect(src).not.toMatch(/label: "Net Worth"/);
    expect(src).toContain('monthSwitch={monthSwitch}');
    expect(src).toContain("const [spendMode, toggleSpendMode] = useSpendMonthMode();");
    expect(src).toContain("mode={spendMode} onToggleMode={toggleSpendMode}");
  });
});
