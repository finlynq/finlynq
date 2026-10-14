/**
 * The built-in chat answers in the user's display currency (2026-10-14).
 *
 * `handleNetWorth` and `handleSpending` were fixed on 2026-07-30, but the
 * budget, transactions, goals, "can I afford", upcoming-bills and summary
 * answers kept `formatCurrency(x, "CAD")` and added raw `SUM(amount)` across
 * currencies: a USD user was told "$" amounts labelled CAD, and a two-currency
 * user got totals that mixed both. The trends answer had the same mixed sum
 * without a label. Every money answer now goes through one of the shared
 * helpers in chat-engine.ts (`moneyContext`, `accountBalances`, `flowTotals`,
 * `budgetStatuses`) or formats a row in its OWN currency, and goal progress
 * comes from the shared `computeGoalProgress` (the figure the Goals page shows).
 *
 * Static gate over the source (comments stripped): a literal currency or a
 * hand-rolled cross-currency sum creeping back in is exactly how this shipped.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const SRC = readFileSync(path.resolve(__dirname, "../src/lib/chat-engine.ts"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

/** The body of one `const handleX: IntentHandler = ...` up to the next one. */
function handler(name: string): string {
  const start = SRC.indexOf(`const ${name}: IntentHandler`);
  expect(start, `${name} exists`).toBeGreaterThan(-1);
  const next = SRC.indexOf(": IntentHandler", start + name.length + 20);
  return SRC.slice(start, next === -1 ? SRC.indexOf("const intents") : next);
}

describe("chat engine money answers", () => {
  it("never names a currency literally", () => {
    expect(SRC).not.toMatch(/["'](CAD|USD|EUR)["']\s*\)/);
    expect(SRC).not.toMatch(/formatCurrency\([^)]*,\s*["'][A-Z]{3}["']/);
  });

  it("every handler that formats a total reads the display currency", () => {
    for (const name of ["handleNetWorth", "handleBudget", "handleTrends", "handleSummary", "handleBalance"]) {
      expect(handler(name), name).toContain("moneyContext(ctx.userId)");
    }
  });

  it("balances come from the shared balance helper, investment accounts at market", () => {
    const helper = SRC.slice(SRC.indexOf("async function accountBalances"), SRC.indexOf("function netWorthOf"));
    expect(helper).toContain("getAccountBalances(ctx.userId, { includeArchived: true })");
    expect(helper).toContain("applyInvestmentMarketOverlay(");
    expect(helper).toContain("convertWithRateMap(native, b.currency, money.rateMap)");
    for (const name of ["handleNetWorth", "handleSummary", "handleBalance"]) {
      expect(handler(name), name).toContain("accountBalances(ctx, money)");
    }
    // "Can I afford" adds up bank accounts, so it converts them first.
    expect(handler("handleForecast")).toContain("accountBalances(ctx, money)");
  });

  it("income and spending go through the flow rules, never a raw cross-currency sum", () => {
    const helper = SRC.slice(SRC.indexOf("async function flowTotals"), SRC.indexOf("type BudgetStatus"));
    expect(helper).toContain("convertReportingSlice(s, money.displayCurrency, money.rateMap)");
    expect(helper).toMatch(/groupBy\(schema\.categories\.type, schema\.transactions\.currency, schema\.transactions\.reportingCurrency\)/);
    expect(handler("handleTrends")).toContain("flowTotals(");
    expect(handler("handleSummary")).toContain("flowTotals(");
  });

  it("budgets convert both the budget and what was spent", () => {
    const helper = SRC.slice(SRC.indexOf("async function budgetStatuses"), SRC.indexOf("const handleNetWorth"));
    expect(helper).toContain("convertWithRateMap(b.budgeted, b.currency, money.rateMap)");
    expect(helper).toContain("convertReportingSlice(s, money.displayCurrency, money.rateMap)");
    expect(handler("handleBudget")).toContain("budgetStatuses(ctx, month, money)");
    expect(handler("handleSummary")).toContain("budgetStatuses(ctx, month, money)");
  });

  it("goals use the shared progress figure, in each goal's own currency", () => {
    const goals = handler("handleGoals");
    expect(goals).toContain("computeGoalProgress(");
    expect(goals).toContain("schema.goalAccounts");
    expect(goals).toContain("formatCurrency(g.current, g.currency)");
  });

  it("single transactions and bills show their own currency", () => {
    const tx = handler("handleTransactions");
    expect(tx).toContain("t.currency || money.displayCurrency");
    expect(tx).toContain("formatCurrency(t.amount, t.currency || displayCurrency)");
    expect(handler("handleForecast")).toContain("r.currency || billCurrency");
  });
});
