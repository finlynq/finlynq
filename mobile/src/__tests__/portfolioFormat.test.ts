import { formatPerShare, formatQty, currencyTotals, signedMoney } from "../lib/portfolio/format";

describe("formatPerShare", () => {
  it("uses 2 decimals for ordinary prices", () => {
    expect(formatPerShare(1.5, "USD")).toBe("$1.50");
    expect(formatPerShare(123.4567891, "USD")).toBe("$123.4568");
    expect(formatPerShare(300, "CAD")).toBe("C$300.00");
  });
  it("keeps up to 4 decimals of real precision, never float noise", () => {
    expect(formatPerShare(0.1234, "USD")).toBe("$0.1234");
    expect(formatPerShare(0.123, "USD")).toBe("$0.123");
    expect(formatPerShare(0.30000000000000004, "USD")).toBe("$0.30");
  });
  it("is null-safe for non-finite input", () => {
    expect(formatPerShare(NaN, "USD")).toBe("—");
  });
});

describe("formatQty", () => {
  it("trims float noise and trailing zeros", () => {
    expect(formatQty(40)).toBe("40");
    expect(formatQty(0.30000000000000004)).toBe("0.3");
    expect(formatQty(1.123456789)).toBe("1.123457");
    expect(formatQty(null)).toBe("0");
    expect(formatQty(-0)).toBe("0");
  });
});

describe("currencyTotals", () => {
  it("lists one entry per currency, largest absolute first", () => {
    expect(
      currencyTotals({ USD: { realizedGain: 10 }, CAD: { realizedGain: -50 } }, (v) => v.realizedGain)
    ).toEqual([
      { currency: "CAD", amount: -50 },
      { currency: "USD", amount: 10 },
    ]);
    expect(currencyTotals(undefined, (v: number) => v)).toEqual([]);
  });
});

describe("signedMoney", () => {
  it("prefixes + for non-negative values only", () => {
    expect(signedMoney(1234.4, "USD")).toBe("+$1,234");
    expect(signedMoney(-56.2, "USD")).toBe("-$56");
    expect(signedMoney(0.42, "USD", 2)).toBe("+$0.42");
  });
});
