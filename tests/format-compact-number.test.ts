/**
 * FINLYNQ-247 — `formatCompactNumber`, the single shared "k"/"m" chart
 * Y-axis abbreviation helper (see src/lib/utils/number.ts). Bare output, NO
 * currency symbol — currency stays a chart-level label, not a per-tick
 * concern. Mirrors the pre-existing `net-worth-history-chart.tsx` `fmtAxis`
 * decimal rules (0 decimals at/above 10k, 1 decimal between 1k-10k) plus a
 * new "m" tier at/above 1e6.
 */
import { describe, it, expect } from "vitest";
import { formatCompactNumber } from "@/lib/utils/number";

describe("formatCompactNumber", () => {
  it("abbreviates thousands with 'k'", () => {
    expect(formatCompactNumber(572345)).toBe("572k");
    expect(formatCompactNumber(1500)).toBe("1.5k");
    expect(formatCompactNumber(9999)).toBe("10.0k");
    expect(formatCompactNumber(10000)).toBe("10k");
  });

  it("abbreviates millions with 'm'", () => {
    expect(formatCompactNumber(1_240_000)).toBe("1.2m");
    expect(formatCompactNumber(1_000_000)).toBe("1.0m");
    expect(formatCompactNumber(25_600_000)).toBe("25.6m");
  });

  it("leaves sub-1000 values as a plain rounded string", () => {
    expect(formatCompactNumber(850)).toBe("850");
    expect(formatCompactNumber(999)).toBe("999");
    expect(formatCompactNumber(12.7)).toBe("13");
  });

  it("is 0-safe", () => {
    expect(formatCompactNumber(0)).toBe("0");
  });

  it("is negative-safe — sign carried through, magnitude rules on |n|", () => {
    expect(formatCompactNumber(-572345)).toBe("-572k");
    expect(formatCompactNumber(-1_240_000)).toBe("-1.2m");
    expect(formatCompactNumber(-850)).toBe("-850");
    expect(formatCompactNumber(-1500)).toBe("-1.5k");
  });
});
