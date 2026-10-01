import { getPresetRange, monthEnd, formatRangeLabel } from "../lib/reports/date-range";

// Local-time constructor (month is 0-based) so every assertion is about the
// device's calendar day, whatever TZ the test runner is in.
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m, d, h, 0, 0);

describe("getPresetRange", () => {
  it("12 mo = 12 complete months ending the last day of the previous month (web parity)", () => {
    expect(getPresetRange("last-12", at(2026, 9, 1))).toEqual({ start: "2025-10-01", end: "2026-09-30" });
    expect(getPresetRange("last-12", at(2026, 5, 15))).toEqual({ start: "2025-06-01", end: "2026-05-31" });
  });

  it("12 mo rolls back across the year boundary in January", () => {
    expect(getPresetRange("last-12", at(2026, 0, 20))).toEqual({ start: "2025-01-01", end: "2025-12-31" });
  });

  it("12 mo ends on Feb 29 in a leap year", () => {
    expect(getPresetRange("last-12", at(2024, 2, 10))).toEqual({ start: "2023-03-01", end: "2024-02-29" });
  });

  it("uses the LOCAL day for the end date, so start never lands after end (user ahead of UTC)", () => {
    // 00:30 local on Oct 1 for a UTC+13 user: UTC is still Sep 30. Process TZ
    // can't be switched reliably at runtime (Windows), so pin the UTC view the
    // old toISOString()-based code read instead.
    const now = new Date(2026, 9, 1, 0, 30, 0);
    now.toISOString = () => "2026-09-30T11:30:00.000Z";
    for (const key of ["mtd", "qtd", "ytd"]) {
      const r = getPresetRange(key, now);
      expect(r.end).toBe("2026-10-01");
      expect(r.start <= r.end).toBe(true);
    }
    expect(getPresetRange("mtd", now).start).toBe("2026-10-01");
    expect(getPresetRange("qtd", now).start).toBe("2026-10-01");
    expect(getPresetRange("ytd", now).start).toBe("2026-01-01");
  });

  it("late in the local evening still reports the local day", () => {
    const now = new Date(2026, 5, 30, 23, 45, 0);
    expect(getPresetRange("mtd", now)).toEqual({ start: "2026-06-01", end: "2026-06-30" });
  });

  it("last month / quarter / year are complete calendar periods", () => {
    const now = at(2026, 0, 15);
    expect(getPresetRange("last-month", now)).toEqual({ start: "2025-12-01", end: "2025-12-31" });
    expect(getPresetRange("last-quarter", now)).toEqual({ start: "2025-10-01", end: "2025-12-31" });
    expect(getPresetRange("last-year", now)).toEqual({ start: "2025-01-01", end: "2025-12-31" });
  });
});

describe("month helpers", () => {
  it("monthEnd handles leap years", () => {
    expect(monthEnd("2024-02")).toBe("2024-02-29");
    expect(monthEnd("2026-02")).toBe("2026-02-28");
  });

  it("formatRangeLabel shows both months", () => {
    expect(formatRangeLabel("2025-10-01", "2026-09-30")).toBe("Oct 2025 – Sep 2026");
  });
});
