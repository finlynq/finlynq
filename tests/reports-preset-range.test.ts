/**
 * Unit tests for getPresetRange — "last-12" complete-calendar-month fix (FINLYNQ-203).
 *
 * The function accepts an optional `now` parameter so we can pin the clock
 * to a known date and assert the exact output without timezone ambiguity.
 */
import { describe, it, expect } from "vitest";
import { getPresetRange } from "@/app/(app)/reports/page";

describe("getPresetRange — last-12 (FINLYNQ-203)", () => {
  it("tc-1: standard case (2026-06-18) → 2025-06-01 to 2026-05-31", () => {
    const result = getPresetRange("last-12", new Date(2026, 5, 18)); // month 5 = June
    expect(result).toEqual({ start: "2025-06-01", end: "2026-05-31" });
  });

  it("tc-2: year boundary (2026-01-05) → 2025-01-01 to 2025-12-31", () => {
    const result = getPresetRange("last-12", new Date(2026, 0, 5)); // month 0 = January
    expect(result).toEqual({ start: "2025-01-01", end: "2025-12-31" });
  });

  it("tc-3: prior month Feb non-leap (2026-03-31) → 2025-03-01 to 2026-02-28", () => {
    const result = getPresetRange("last-12", new Date(2026, 2, 31)); // month 2 = March
    expect(result).toEqual({ start: "2025-03-01", end: "2026-02-28" });
  });

  it("tc-4: prior month Feb leap (2024-03-10) → 2023-03-01 to 2024-02-29", () => {
    const result = getPresetRange("last-12", new Date(2024, 2, 10)); // month 2 = March; 2024 is a leap year
    expect(result).toEqual({ start: "2023-03-01", end: "2024-02-29" });
  });
});
