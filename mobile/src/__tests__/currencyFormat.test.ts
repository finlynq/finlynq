import { currencyDecimals, formatCompactMoney, formatCurrency, formatWholeMoney, roundWhole } from "../lib/format";

describe("formatWholeMoney (FINLYNQ-318)", () => {
  it("rounds half away from zero, with no decimals", () => {
    expect(roundWhole(2.5)).toBe(3);
    expect(roundWhole(-2.5)).toBe(-3);
    expect(roundWhole(-0.4)).toBe(0);
    expect(Object.is(roundWhole(-0.4), -0)).toBe(false);
    expect(formatWholeMoney(39933.28, "USD")).toBe("$39,933");
    expect(formatWholeMoney(1214.5, "USD")).toBe("$1,215");
    expect(formatWholeMoney(-50.5, "USD")).toBe("-$51");
  });

  it("writes every dollar currency with a bare $, since the screen names the currency once", () => {
    expect(formatWholeMoney(8057.4, "CAD")).toBe("$8,057");
    expect(formatWholeMoney(8057.4, "AUD")).toBe("$8,057");
    expect(formatWholeMoney(8057.4, "HKD")).toBe("$8,057");
  });

  it("keeps the narrow symbol for other currencies", () => {
    expect(formatWholeMoney(1234.4, "EUR")).toBe("€1,234");
    expect(formatWholeMoney(1234.4, "GBP")).toBe("£1,234");
    expect(formatWholeMoney(1234.4, "JPY")).toBe("¥1,234");
  });

  it("says <$1 for an amount that isn't zero but rounds to it, and $0 for float noise", () => {
    expect(formatWholeMoney(0.4, "CAD")).toBe("<$1");
    expect(formatWholeMoney(-0.4, "CAD")).toBe("-<$1");
    expect(formatWholeMoney(0.004, "CAD")).toBe("$0");
    expect(formatWholeMoney(0, "CAD")).toBe("$0");
  });

  it("fits seven digits on one line", () => {
    expect(formatWholeMoney(9999999.49, "USD")).toBe("$9,999,999");
  });
});

describe("formatCompactMoney (FINLYNQ-318)", () => {
  it("shortens heading totals to one decimal and drops .0", () => {
    expect(formatCompactMoney(39933.28, "CAD")).toBe("$39.9k");
    expect(formatCompactMoney(31020, "CAD")).toBe("$31k");
    expect(formatCompactMoney(4865, "CAD")).toBe("$4.9k");
    expect(formatCompactMoney(1_250_000, "USD")).toBe("$1.3M");
    expect(formatCompactMoney(999_960, "USD")).toBe("$1M");
    expect(formatCompactMoney(-1500, "USD")).toBe("-$1.5k");
  });

  it("stays whole under 1,000", () => {
    expect(formatCompactMoney(940.2, "USD")).toBe("$940");
    expect(formatCompactMoney(999.4, "USD")).toBe("$999");
    expect(formatCompactMoney(999.6, "USD")).toBe("$1k");
  });
});

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
