/**
 * GH #463: the Forecast banner names the real reason a line is blank.
 * - a budget for this month only is called out (the forecast starts next month)
 * - with a History layer on, it says the lookback found nothing
 * - the inputs carry this month's budgets so the page can tell
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { explainBlankLines } from "@/lib/forecast/blank-lines";
import { layerSchema } from "@/lib/forecast/config";

const blank = [
  { key: "c:1", label: "Rideshare", type: "expense" },
  { key: "c:2", label: "Car payment", type: "expense" },
  { key: "c:3", label: "Gifts", type: "expense" },
];
const historyMonths = Array.from({ length: 24 }, (_, i) => `2025-${String((i % 12) + 1).padStart(2, "0")}`);
const budgetLayer = layerSchema.parse({ id: "b", kind: "budget", label: "Budget", enabled: true });

describe("explainBlankLines", () => {
  it("names lines budgeted for this month only and the months involved", () => {
    const e = explainBlankLines(
      blank,
      { startMonth: "2026-04", currentMonthBudget: { "c:1": 50, "c:2": 400 }, historyMonths },
      { layers: [budgetLayer] },
    );
    expect(e.startMonth).toBe("2026-04");
    expect(e.currentMonth).toBe("2026-03");
    expect(e.thisMonthOnly).toEqual(["Rideshare", "Car payment"]);
    expect(e.historyLookback).toBeNull();
  });

  it("crosses a year boundary for the current month", () => {
    const e = explainBlankLines(blank, { startMonth: "2027-01", historyMonths }, { layers: [] });
    expect(e.currentMonth).toBe("2026-12");
    expect(e.thisMonthOnly).toEqual([]);
  });

  it("reports the lookback of an enabled History layer, not a switched-off one", () => {
    const on = layerSchema.parse({ id: "h", kind: "history", label: "History", enabled: true, params: { lookbackMonths: 6 } });
    const off = { ...on, enabled: false };
    expect(explainBlankLines(blank, { startMonth: "2026-04", historyMonths }, { layers: [budgetLayer, on] }).historyLookback).toBe(6);
    expect(explainBlankLines(blank, { startMonth: "2026-04", historyMonths }, { layers: [budgetLayer, off] }).historyLookback).toBeNull();
  });

  it("caps the lookback at the history actually loaded", () => {
    const on = layerSchema.parse({ id: "h", kind: "history", label: "History", enabled: true, params: { lookbackMonths: 12 } });
    const e = explainBlankLines(blank, { startMonth: "2026-04", historyMonths: historyMonths.slice(0, 3) }, { layers: [on] });
    expect(e.historyLookback).toBe(3);
  });
});

describe("banner wiring", () => {
  const strip = readFileSync("src/app/(app)/forecast/_components/forecast-overview.tsx", "utf8");
  const inputs = readFileSync("src/lib/forecast/inputs.ts", "utf8");

  it("no longer claims every blank line has no budget, and links to the first forecast month", () => {
    expect(strip).not.toMatch(/no budget, so/);
    expect(strip).not.toMatch(/href="\/budgets"/);
    expect(strip).toMatch(/\/budgets\?month=\$\{explain\.startMonth\}/);
  });

  it("loads budgets from the current month so a this-month-only budget can be told apart", () => {
    expect(inputs).toMatch(/loadBudgetsByMonth\(ctx, ctx\.currentMonth, endMonth\)/);
    expect(inputs).toMatch(/currentMonthBudget,/);
  });
});
