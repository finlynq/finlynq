/**
 * Loan currency: precedence rule + a static wiring gate over the surfaces
 * that have to honour it.
 *
 * WHY THIS EXISTS
 * ---------------
 * `loans.currency` existed and the REST create path persisted it from day one
 * (FINLYNQ-136). Everything else quietly dropped it:
 *
 *   * MCP `manage_loans(op:add)` omitted the column from its INSERT, so every
 *     loan created through an assistant took the table default — which was CAD.
 *   * `manage_loans(op:list)` and `get_debt_payoff_plan` never SELECTed it.
 *   * The web `/loans` page formatted every amount in the DISPLAY currency, so
 *     a ₽8,116,000 mortgage rendered as $8,116,000, and totalled native amounts
 *     across currencies under a single symbol.
 *
 * The payoff planner is the one where the numbers, not just the labels, came
 * out wrong: snowball ORDERS by balance and the `extra_payment` budget is
 * POOLED across every debt, so an unconverted RUB balance outranked every USD
 * debt by ~80x and absorbed the whole budget.
 *
 * The precedence tests below are pure. The wiring assertions are pure source
 * reads: they cannot prove runtime behaviour, but they catch the regression
 * this codebase has actually shipped before — a rule that exists and is
 * correct while some call site quietly fails to use it.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { pickRecordCurrency } from "../src/lib/fx/record-currency";
import { calculateDebtPayoff, type Debt } from "../src/lib/loan-calculator";

const ROOT = path.resolve(__dirname, "..");
const HTTP_LOANS = readFileSync(path.join(ROOT, "mcp-server/tools/loans.ts"), "utf8");
const STDIO_TOOLS = readFileSync(path.join(ROOT, "mcp-server/register-core-tools.ts"), "utf8");
const REST_LOANS = readFileSync(path.join(ROOT, "src/app/api/loans/route.ts"), "utf8");
const LOANS_PAGE = readFileSync(path.join(ROOT, "src/app/(app)/loans/page.tsx"), "utf8");
const SCHEMA = readFileSync(path.join(ROOT, "src/db/schema-pg.ts"), "utf8");

/**
 * Strip comments — the files below document the very literals some assertions
 * forbid ("CAD"), so a raw substring match would trip on the prose explaining
 * why it is gone.
 */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("pickRecordCurrency — explicit > account > display", () => {
  it("prefers an explicit code over everything else", () => {
    expect(
      pickRecordCurrency({ explicit: "RUB", accountCurrency: "USD", displayCurrency: "EUR" }),
    ).toBe("RUB");
  });

  it("falls back to the owning account's currency", () => {
    expect(
      pickRecordCurrency({ accountCurrency: "RUB", displayCurrency: "USD" }),
    ).toBe("RUB");
  });

  it("falls back to the display currency last", () => {
    expect(pickRecordCurrency({ displayCurrency: "RUB" })).toBe("RUB");
  });

  it("normalizes case and whitespace", () => {
    expect(pickRecordCurrency({ explicit: " rub ", displayCurrency: "USD" })).toBe("RUB");
  });

  it("treats blank strings as absent rather than as a choice", () => {
    // An empty form field must not beat the account's real currency.
    expect(
      pickRecordCurrency({ explicit: "", accountCurrency: "RUB", displayCurrency: "USD" }),
    ).toBe("RUB");
    expect(
      pickRecordCurrency({ explicit: "   ", accountCurrency: "", displayCurrency: "USD" }),
    ).toBe("USD");
  });

  it("never returns CAD unless CAD was actually asked for", () => {
    expect(pickRecordCurrency({ displayCurrency: "" })).toBe("USD");
    expect(pickRecordCurrency({ explicit: "CAD", displayCurrency: "USD" })).toBe("CAD");
  });
});

describe("debt payoff is only meaningful in one currency", () => {
  // Pins the behaviour the conversion protects, using the real calculator.
  // 500,000 RUB ≈ $5,500 at ~0.011 — genuinely the SECOND smallest debt here,
  // but the largest number on the page. Snowball pays smallest-balance first,
  // so the unconverted figure sends it to the back of the queue.
  const RUB_TO_USD = 0.011;
  const native: Debt[] = [
    { id: 1, name: "RUB loan", balance: 500_000, rate: 6.25, minPayment: 9_000 },
    { id: 2, name: "USD card", balance: 4_000, rate: 22.0, minPayment: 150 },
    { id: 3, name: "USD auto", balance: 18_000, rate: 5.0, minPayment: 400 },
  ];
  const converted: Debt[] = native.map((d) =>
    d.id === 1
      ? { ...d, balance: d.balance * RUB_TO_USD, minPayment: d.minPayment * RUB_TO_USD }
      : d,
  );

  it("snowball order changes once balances share a currency", () => {
    const nativeOrder = calculateDebtPayoff(native, 500, "snowball").order.map((o) => o.name);
    const convertedOrder = calculateDebtPayoff(converted, 500, "snowball").order.map((o) => o.name);
    // Unconverted, the RUB loan goes last purely because its NUMBER is biggest
    // — an ~80x distortion, not a financial judgement.
    expect(nativeOrder).toEqual(["USD card", "USD auto", "RUB loan"]);
    // Converted, it takes its real place: second smallest.
    expect(convertedOrder).toEqual(["USD card", "RUB loan", "USD auto"]);
  });

  it("avalanche ranks on rate, which is currency-independent", () => {
    // Rates are percentages, so ordering was always sound — documenting this
    // keeps a future refactor from "fixing" it by converting the rate.
    const order = calculateDebtPayoff(converted, 0, "avalanche").order.map((o) => o.name);
    expect(order[0]).toBe("USD card");
  });
});

describe("wiring: every loan surface carries the currency", () => {
  it("the loans table defaults to USD, not CAD", () => {
    const loansBlock = SCHEMA.slice(SCHEMA.indexOf('pgTable("loans"'));
    const currencyLine = codeOnly(loansBlock).split("\n").find((l) => l.includes('currency: text('));
    expect(currencyLine).toBeDefined();
    expect(currencyLine).toContain('default("USD")');
  });

  it("MCP add_loan persists a resolved currency instead of the column default", () => {
    expect(HTTP_LOANS).toContain("pickRecordCurrency");
    // The INSERT must name the column; omitting it is the original bug.
    const insert = HTTP_LOANS.slice(HTTP_LOANS.indexOf("INSERT INTO loans"));
    expect(insert.slice(0, 400)).toContain("currency");
  });

  it("both debt-payoff planners SELECT currency and convert before ranking", () => {
    for (const [label, src] of [["http", HTTP_LOANS], ["stdio", STDIO_TOOLS]] as const) {
      const start = src.indexOf("get_debt_payoff_plan");
      expect(start, `${label}: tool not found`).toBeGreaterThan(-1);
      const body = src.slice(start);
      const handler = body.slice(0, body.indexOf("get_fx_rate") > -1 ? body.indexOf("get_fx_rate") : 8000);
      expect(handler, `${label}: SELECT must include currency`).toContain("currency");
      expect(handler, `${label}: balances must be converted`).toContain("convertWithRateMap");
      expect(handler, `${label}: needs a rate map`).toContain("getRateMap");
    }
  });

  it("no loan surface falls back to a CAD literal", () => {
    for (const [label, src] of [
      ["mcp http loans", HTTP_LOANS],
      ["rest /api/loans", REST_LOANS],
      ["loans page", LOANS_PAGE],
    ] as const) {
      expect(codeOnly(src), `${label} still has a CAD literal`).not.toMatch(/["']CAD["']/);
    }
  });

  it("the loans page formats per-loan amounts in the loan's own currency", () => {
    const code = codeOnly(LOANS_PAGE);
    // Totals are the ONLY thing allowed to use displayCurrency for money, and
    // they must read the server-converted companions to do it.
    expect(code).toContain("remainingBalanceDisplay");
    expect(code).toContain("monthlyEquivalentPaymentDisplay");
    expect(code).toContain("formatCurrency(loan.remainingBalance, loan.currency)");
    // The old bug, verbatim: native balance rendered in the display currency.
    expect(code).not.toContain("formatCurrency(loan.remainingBalance, displayCurrency)");
    expect(code).not.toContain("formatCurrency(loan.totalInterest, displayCurrency)");
  });

  it("REST GET emits the reporting-currency companions", () => {
    expect(REST_LOANS).toContain("remainingBalanceDisplay");
    expect(REST_LOANS).toContain("monthlyEquivalentPaymentDisplay");
    expect(REST_LOANS).toContain("getRateMap");
  });
});
