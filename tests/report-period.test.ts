import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  REPORT_PERIODS,
  REPORT_PERIOD_LABELS,
  MULTI_YEAR_PRESETS,
  ALL_TIME_START,
  isReportPeriod,
  isReportDate,
} from "@/lib/reports/period";

// A browser date input reports every keystroke of the year: typing "2010"
// sends 0002-01-01, 0020-01-01 and 0201-01-01 first. Each priced the whole
// portfolio at that year (2026-11-07 daily check).
describe("isReportDate", () => {
  it("accepts real dates from ALL_TIME_START on", () => {
    for (const d of [ALL_TIME_START, "2010-01-01", "2024-02-29", "2026-11-07", "2099-12-31"]) {
      expect(isReportDate(d)).toBe(true);
    }
  });

  it("rejects the years a half-typed date passes through", () => {
    for (const d of ["0002-01-01", "0020-01-01", "0201-01-01", "1969-12-31"]) {
      expect(isReportDate(d)).toBe(false);
    }
  });

  it("rejects anything that is not a real YYYY-MM-DD date", () => {
    for (const d of ["", "2025-02-29", "2026-13-01", "2026-04-31", "2026-1-5", "20101-01-01", "abc", null, undefined, 20260101]) {
      expect(isReportDate(d)).toBe(false);
    }
  });
});

describe("report periods", () => {
  it("includes yearly", () => {
    expect(REPORT_PERIODS).toContain("yearly");
    expect(isReportPeriod("yearly")).toBe(true);
  });

  it("rejects values that are not a period", () => {
    for (const v of ["", "year", "annual", "decade", null, undefined, 5]) {
      expect(isReportPeriod(v)).toBe(false);
    }
  });

  it("has a label for every period", () => {
    for (const p of REPORT_PERIODS) expect(REPORT_PERIOD_LABELS[p]).toBeTruthy();
  });

  // The mobile app types its period chips from shared/types.ts, which cannot
  // import from src/lib. A period added on one side only is a chip the server
  // 400s, or a server option the app can never send.
  it("shared/types.ts ReportPeriod lists the same values", () => {
    const src = readFileSync(join(process.cwd(), "shared/types.ts"), "utf8");
    const m = src.match(/export type ReportPeriod =([^;]+);/);
    expect(m).not.toBeNull();
    const shared = [...m![1].matchAll(/"([a-z]+)"/g)].map((x) => x[1]).sort();
    expect(shared).toEqual([...REPORT_PERIODS].sort());
  });

  // Every preset that flips the Period select to yearly must be a real preset.
  it("multi-year presets exist in getPresetRange", () => {
    const page = readFileSync(join(process.cwd(), "src/app/(app)/reports/page.tsx"), "utf8");
    for (const preset of MULTI_YEAR_PRESETS) expect(page).toContain(`case "${preset}":`);
  });
});
