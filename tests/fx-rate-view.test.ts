/**
 * Exchange-rate display (2026-11-09): every rate names its pair, small rates
 * keep 6 significant digits, and "show rates inverted" flips the pair only.
 */

import { describe, it, expect } from "vitest";
import { formatFxRate, formatRateNumber, rateView } from "@/lib/fx/rate-view";

describe("formatRateNumber", () => {
  it("keeps 6 significant digits below 1", () => {
    expect(formatRateNumber(8.340909698745236e-5)).toBe("0.0000834091");
    expect(formatRateNumber(0.8931000232696533)).toBe("0.8931");
  });
  it("6 significant digits from 1 up, never dropping whole digits", () => {
    expect(formatRateNumber(18039.0002)).toBe("18,039");
    expect(formatRateNumber(1.1196954250335693)).toBe("1.1197");
    expect(formatRateNumber(150.12345)).toBe("150.123");
    expect(formatRateNumber(1234567.89)).toBe("1,234,568");
  });
  it("shows a dash for nothing usable", () => {
    for (const n of [0, -1, NaN, Infinity]) expect(formatRateNumber(n)).toBe("—");
  });
});

describe("formatFxRate", () => {
  it("as quoted: 1 FROM = rate TO", () => {
    expect(formatFxRate(5.543544466490857e-5, "IDR", "USD", false)).toBe("1 IDR = 0.0000554354 USD");
  });
  it("inverted: 1 TO = 1/rate FROM", () => {
    expect(formatFxRate(5.543544466490857e-5, "IDR", "USD", true)).toBe("1 USD = 18,039 IDR");
    expect(formatFxRate(1.36, "USD", "CAD", true)).toBe("1 CAD = 0.735294 USD");
  });
  it("never inverts a zero or negative rate", () => {
    expect(rateView(0, "A", "B", true)).toEqual({ base: "A", quote: "B", value: 0 });
  });
});
