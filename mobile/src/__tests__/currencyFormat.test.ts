import { currencyDecimals, formatCurrency } from "../lib/format";

// What the web's `currencyDecimals` reads back: the number of decimals `Intl`
// writes a currency with.
const intlDecimals = (code: string): number =>
  new Intl.NumberFormat("en", { style: "currency", currency: code }).resolvedOptions().maximumFractionDigits ?? 2;

describe("currencyDecimals", () => {
  it("knows the currencies written without decimals, and those written with three", () => {
    expect(currencyDecimals("JPY")).toBe(0);
    expect(currencyDecimals("KRW")).toBe(0);
    expect(currencyDecimals("VND")).toBe(0);
    expect(currencyDecimals("KWD")).toBe(3);
    expect(currencyDecimals("BHD")).toBe(3);
  });

  it("everything else has two, including a code the user made up", () => {
    expect(currencyDecimals("USD")).toBe(2);
    expect(currencyDecimals("EUR")).toBe(2);
    expect(currencyDecimals("TEST")).toBe(2);
    expect(currencyDecimals("")).toBe(2);
  });

  // The table stands in for `Intl`, which is what the web uses. Checked both
  // ways over every currency `Intl` knows: a currency missing from the table,
  // or one in it that `Intl` writes with two decimals, fails here.
  it("agrees with Intl for every currency", () => {
    const disagree = Intl.supportedValuesOf("currency")
      .filter((code) => currencyDecimals(code) !== intlDecimals(code))
      .map((code) => `${code}: table ${currencyDecimals(code)}, Intl ${intlDecimals(code)}`);
    expect(disagree).toEqual([]);
  });
});

describe("formatCurrency", () => {
  it("writes a currency with its own decimals", () => {
    expect(formatCurrency(1234.5, "USD")).toBe("$1,234.50");
    expect(formatCurrency(1234.5, "CAD")).toBe("C$1,234.50");
    expect(formatCurrency(1234.5, "JPY")).not.toMatch(/[.,]\d{2}$/);
    expect(formatCurrency(1234.5, "JPY")).toMatch(/1,23[45]$/);
    expect(formatCurrency(1.5, "KWD")).toMatch(/1\.500$/);
  });

  it("a caller can still ask for a different number of decimals", () => {
    expect(formatCurrency(1234.5, "USD", { decimals: 0 })).toBe("$1,235");
    expect(formatCurrency(1234, "JPY", { decimals: 2 })).toMatch(/1,234\.00$/);
  });

  it("keeps the sign in front of the symbol", () => {
    expect(formatCurrency(-12.3, "USD")).toBe("-$12.30");
  });

  it("does not throw on a code that is not a currency", () => {
    expect(formatCurrency(12.345, "TEST")).toBe("TEST 12.35");
    expect(formatCurrency(-5, "TEST")).toBe("-TEST 5.00");
  });
});
