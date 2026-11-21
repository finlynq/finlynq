/**
 * GH #427: saved reports and saved Transactions views, the pure half
 * (src/lib/saved-views/config.ts): what a config may hold, and that a
 * relative range stays relative.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkSavedViewName,
  describeSavedDateRange,
  parseSavedViewConfig,
  rangeForDates,
  resolveSavedDateRange,
  resolveSavedViewDates,
  savedViewPath,
  SAVED_VIEW_NAME_MAX,
} from "@/lib/saved-views/config";
import { getPresetRange, REPORT_DATE_PRESETS } from "@/lib/reports/presets";

const report = {
  tab: "income",
  date: { kind: "preset", preset: "last-12" },
  period: "monthly",
  groupBy: "category",
  accountIds: [3, 7],
  tag: "spending-money",
  business: false,
  yoy: null,
};

describe("saved view names", () => {
  it("trims and collapses spaces", () => {
    expect(checkSavedViewName("  Spending   money ")).toEqual({ ok: true, name: "Spending money" });
  });
  it("refuses an empty or over-long name", () => {
    expect(checkSavedViewName("   ").ok).toBe(false);
    expect(checkSavedViewName("x".repeat(SAVED_VIEW_NAME_MAX + 1)).ok).toBe(false);
    expect(checkSavedViewName(42).ok).toBe(false);
  });
});

describe("report config", () => {
  it("accepts a full report config and keeps the preset key, not dates", () => {
    const r = parseSavedViewConfig("report", report);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.date).toEqual({ kind: "preset", preset: "last-12" });
    expect(JSON.stringify(r.config)).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("fills defaults for fields an older config doesn't have", () => {
    const r = parseSavedViewConfig("report", {
      tab: "cashflow",
      date: { kind: "custom", start: "2026-01-01", end: "2026-03-31" },
      period: "quarterly",
      groupBy: "group",
    });
    expect(r).toMatchObject({ ok: true, config: { accountIds: [], tag: null, business: false, yoy: null } });
  });

  it("stores a blank tag as no tag", () => {
    const r = parseSavedViewConfig("report", { ...report, tag: "   " });
    expect(r.ok && r.config).toMatchObject({ tag: null });
  });

  it("refuses an unknown tab, period, preset or a bad custom date", () => {
    expect(parseSavedViewConfig("report", { ...report, tab: "nope" }).ok).toBe(false);
    expect(parseSavedViewConfig("report", { ...report, period: "hourly" }).ok).toBe(false);
    expect(parseSavedViewConfig("report", { ...report, date: { kind: "preset", preset: "last-7" } }).ok).toBe(false);
    expect(parseSavedViewConfig("report", { ...report, date: { kind: "custom", start: "2026-02-30", end: "2026-03-01" } }).ok).toBe(false);
    // A report's custom range needs both ends.
    expect(parseSavedViewConfig("report", { ...report, date: { kind: "custom", start: "2026-01-01" } }).ok).toBe(false);
  });

  it("refuses an oversized config", () => {
    const r = parseSavedViewConfig("report", { ...report, accountIds: Array.from({ length: 501 }, (_, i) => i + 1) });
    expect(r.ok).toBe(false);
  });
});

describe("transactions config", () => {
  it("accepts filters, sort, column filters, columns and view", () => {
    const r = parseSavedViewConfig("transactions", {
      date: { kind: "custom", start: "2026-01-01" },
      accountId: "12",
      categoryId: "",
      search: "coffee",
      tag: "spending-money",
      sort: { columnId: "amount", direction: "asc" },
      colFilters: [{ type: "numeric", columnId: "amount", op: "gt", value: 10 }],
      columns: [{ id: "date", visible: true }, { id: "payee", visible: false }],
      view: "calendar",
      calMode: "week",
    });
    expect(r.ok).toBe(true);
  });

  it("allows an open-ended range and fills the rest with defaults", () => {
    const r = parseSavedViewConfig("transactions", { date: { kind: "custom" } });
    expect(r).toMatchObject({
      ok: true,
      config: { accountId: "", sort: { columnId: null, direction: null }, colFilters: [], columns: null, view: "list", calMode: "month" },
    });
  });

  it("refuses a non-id account, an unsortable column or an unknown column filter", () => {
    expect(parseSavedViewConfig("transactions", { date: { kind: "custom" }, accountId: "12; drop" }).ok).toBe(false);
    expect(parseSavedViewConfig("transactions", { date: { kind: "custom" }, sort: { columnId: "payee", direction: "asc" } }).ok).toBe(false);
    expect(
      parseSavedViewConfig("transactions", { date: { kind: "custom" }, colFilters: [{ type: "text", columnId: "nope", value: "x" }] }).ok,
    ).toBe(false);
  });
});

describe("relative dates stay relative", () => {
  it("resolves a preset for the day the view is opened", () => {
    const range = { kind: "preset", preset: "last-12" } as const;
    expect(resolveSavedDateRange(range, new Date(2026, 5, 18))).toEqual({ start: "2025-06-01", end: "2026-05-31" });
    // The same saved view a year later covers a different year.
    expect(resolveSavedDateRange(range, new Date(2027, 5, 18))).toEqual({ start: "2026-06-01", end: "2027-05-31" });
  });

  it("resolves every preset through the Reports page's own preset math", () => {
    const now = new Date(2026, 9, 12);
    for (const preset of REPORT_DATE_PRESETS) {
      expect(resolveSavedDateRange({ kind: "preset", preset }, now)).toEqual(getPresetRange(preset, now));
    }
  });

  it("year to date ends on the day it is opened", () => {
    expect(resolveSavedDateRange({ kind: "preset", preset: "ytd" }, new Date(2026, 10, 21))).toEqual({
      start: "2026-01-01",
      end: "2026-11-21",
    });
  });

  it("keeps a custom range's fixed dates and open ends", () => {
    expect(resolveSavedDateRange({ kind: "custom", start: "2026-01-01", end: "2026-03-31" })).toEqual({
      start: "2026-01-01",
      end: "2026-03-31",
    });
    expect(resolveSavedDateRange({ kind: "custom" })).toEqual({ start: "", end: "" });
  });

  it("describes a range", () => {
    expect(describeSavedDateRange({ kind: "preset", preset: "last-12" })).toBe("Last 12 Months");
    expect(describeSavedDateRange({ kind: "custom", start: "2026-01-01", end: "2026-03-31" })).toBe("2026-01-01 to 2026-03-31");
    expect(describeSavedDateRange({ kind: "custom", start: "2026-01-01" })).toBe("From 2026-01-01");
    expect(describeSavedDateRange({ kind: "custom" })).toBe("Any date");
  });

  it("saving changes keeps a preset while the dates still match it", () => {
    const now = new Date(2026, 5, 18);
    const previous = { kind: "preset", preset: "last-12" } as const;
    expect(rangeForDates("2025-06-01", "2026-05-31", previous, now)).toBe(previous);
    // The user changed the dates: store what is shown.
    expect(rangeForDates("2025-01-01", "2026-05-31", previous, now)).toEqual({
      kind: "custom",
      start: "2025-01-01",
      end: "2026-05-31",
    });
    // No dates shown: any date.
    expect(rangeForDates("", "", null, now)).toEqual({ kind: "custom" });
  });

  it("resolves a saved view's dates for the MCP tool", () => {
    const parsed = parseSavedViewConfig("report", report);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(resolveSavedViewDates(parsed.config, new Date(2026, 5, 18))).toEqual({
      startDate: "2025-06-01",
      endDate: "2026-05-31",
      dateRange: "Last 12 Months",
    });
  });
});

describe("links and wiring", () => {
  it("links each kind to its page", () => {
    expect(savedViewPath("report", 4)).toBe("/reports?savedView=4");
    expect(savedViewPath("transactions", 9)).toBe("/transactions?savedView=9");
  });

  // The Reports page's Range select must offer exactly the presets a saved
  // report can store (one list, src/lib/reports/presets.ts).
  it("the Reports page builds its Range select from the shared preset list", () => {
    const page = readFileSync(join(process.cwd(), "src/app/(app)/reports/page.tsx"), "utf8");
    expect(page).toContain("REPORT_DATE_PRESETS.map(");
    expect(page).not.toMatch(/<SelectItem value="last-12">/);
  });

  // Tags are encrypted: both tag-aware report routes must go through the
  // decrypt-then-match helper, never a SQL LIKE on the tags column.
  it("the trends and year-over-year routes filter by tag through reports/tag-filter.ts", () => {
    for (const route of ["src/app/api/reports/trends/route.ts", "src/app/api/reports/yoy/route.ts"]) {
      const src = readFileSync(join(process.cwd(), route), "utf8");
      expect(src).toContain("transactionIdsWithTag(");
      expect(src).toContain("flowIdIn(");
    }
  });
});
