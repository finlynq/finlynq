/**
 * GH #463: the Forecast banner names the real reason a line is blank.
 * - a budget for this month only is called out (the forecast starts next month)
 * - with a History layer on, it says the lookback found nothing
 * - the inputs carry this month's budgets so the page can tell
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  areNotesDismissed,
  explainBlankLines,
  forecastNoteKeys,
  parseDismissedKeys,
} from "@/lib/forecast/blank-lines";
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

describe("dismissing the Forecast notes strip (GH #469)", () => {
  const blank = [{ key: "c:1" }, { key: "c:2" }];
  const notes = [{ key: "warn:scheduled_excluded::1 category" }, { key: "left:c:9:covered" }];

  it("keys every note: blank lines plus warnings and left-out lines, once each", () => {
    expect(forecastNoteKeys([...blank, { key: "c:1" }], notes)).toEqual([
      "blank:c:1",
      "blank:c:2",
      "left:c:9:covered",
      "warn:scheduled_excluded::1 category",
    ]);
  });

  it("hides the whole strip, warnings included, once everything shown was dismissed", () => {
    const keys = forecastNoteKeys(blank, notes);
    expect(areNotesDismissed(keys, keys)).toBe(true);
    // A strip with only warnings (no blank lines) can be dismissed too.
    const warnOnly = forecastNoteKeys([], notes);
    expect(areNotesDismissed(warnOnly, warnOnly)).toBe(true);
  });

  it("comes back when a new blank line, a new warning or a changed warning appears", () => {
    const keys = forecastNoteKeys(blank, notes);
    expect(areNotesDismissed(forecastNoteKeys([...blank, { key: "g:Food" }], notes), keys)).toBe(false);
    expect(areNotesDismissed(forecastNoteKeys(blank, [...notes, { key: "warn:cash_negative::x" }]), keys)).toBe(false);
    expect(areNotesDismissed(forecastNoteKeys(blank, [{ key: "warn:scheduled_excluded::2 categories" }]), keys)).toBe(false);
  });

  it("stays hidden when a note goes away, and is never 'dismissed' with nothing to show", () => {
    const keys = forecastNoteKeys(blank, notes);
    expect(areNotesDismissed(forecastNoteKeys([{ key: "c:1" }], []), keys)).toBe(true);
    expect(areNotesDismissed([], keys)).toBe(false);
    expect(areNotesDismissed(keys, [])).toBe(false);
  });

  it("reads stored keys, junk as nothing dismissed", () => {
    expect(parseDismissedKeys(JSON.stringify(["a", 3, "b"]))).toEqual(["a", "b"]);
    expect(parseDismissedKeys("{oops")).toEqual([]);
    expect(parseDismissedKeys(null)).toEqual([]);
    expect(parseDismissedKeys('{"a":1}')).toEqual([]);
  });

  it("the page keys every note and wires the X to the whole strip, with a way back", () => {
    const page = readFileSync("src/app/(app)/forecast/page.tsx", "utf8");
    expect(page).toMatch(/onDismiss=\{\(\) => saveDismissedNoteKeys\(noteKeys\)\}/);
    expect(page).toMatch(/onShowHidden=\{\(\) => saveDismissedNoteKeys\(\[\]\)\}/);
    expect(page).toMatch(/key: `warn:/);
    expect(page).toMatch(/key: `left:/);
    const strip = readFileSync("src/app/(app)/forecast/_components/forecast-overview.tsx", "utf8");
    // The X is not limited to the blank-lines case.
    expect(strip).toMatch(/\{onDismiss && \(/);
    expect(strip).not.toMatch(/hasBlank && onDismiss/);
  });
});
