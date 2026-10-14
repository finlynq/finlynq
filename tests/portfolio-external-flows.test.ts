/**
 * What counts as NEW MONEY for portfolio performance (owner's rule,
 * 2026-10-14): src/lib/portfolio/performance/external-flows.ts.
 */

import { describe, it, expect } from "vitest";
import { isNewMoney, newMoneyAmount, type FlowRow } from "@/lib/portfolio/performance/external-flows";

const row = (over: Partial<FlowRow>): FlowRow => ({
  kind: null,
  linkId: null,
  tradeLinkId: null,
  amount: 100,
  quantity: null,
  categoryId: null,
  categoryType: null,
  ...over,
});

const DIVIDENDS = 511;
const INTEREST = 512;
const incomeIds = new Set([DIVIDENDS, INTEREST]);

describe("isNewMoney", () => {
  it("counts transfer legs, as before", () => {
    expect(isNewMoney(row({ linkId: "t1", kind: "brokerage_deposit_in" }), incomeIds)).toBe(true);
    expect(isNewMoney(row({ linkId: "t2", amount: -500, kind: "sell" }), incomeIds)).toBe(true);
  });

  it("counts deposits, withdrawals, opening balances and adjustments even when unlinked", () => {
    for (const kind of ["brokerage_deposit_in", "brokerage_withdrawal_out", "opening_balance", "balance_adjustment"]) {
      expect(isNewMoney(row({ kind }), incomeIds)).toBe(true);
    }
  });

  it("counts anything categorized as a Transfer, whatever its kind", () => {
    expect(isNewMoney(row({ kind: "portfolio_expense", amount: -14391, categoryId: 520, categoryType: "R" }), incomeIds)).toBe(true);
    expect(isNewMoney(row({ kind: "interest", amount: 10, categoryId: 518, categoryType: "R" }), incomeIds)).toBe(true);
  });

  it("counts reinvested income outside Dividends / Interest (payroll plan contributions)", () => {
    expect(isNewMoney(row({ kind: "portfolio_income", amount: 22.5, quantity: 0.0358, categoryId: 516, categoryType: "I" }), incomeIds)).toBe(true);
  });

  it("keeps dividends, interest and fees as return", () => {
    expect(isNewMoney(row({ kind: "portfolio_income", categoryId: DIVIDENDS, categoryType: "I" }), incomeIds)).toBe(false);
    expect(isNewMoney(row({ kind: "portfolio_income", categoryId: INTEREST, categoryType: "I" }), incomeIds)).toBe(false);
    expect(isNewMoney(row({ kind: "dividend", categoryId: 999, categoryType: "I" }), incomeIds)).toBe(false);
    expect(isNewMoney(row({ kind: "interest", categoryId: 999, categoryType: "I" }), incomeIds)).toBe(false);
    expect(isNewMoney(row({ kind: "portfolio_expense", amount: -15, categoryId: 1354, categoryType: "E" }), incomeIds)).toBe(false);
  });

  it("keeps uncategorized income as return (dividends often arrive uncategorized)", () => {
    expect(isNewMoney(row({ kind: "portfolio_income" }), incomeIds)).toBe(false);
  });

  it("without the user's key, categorized income stays return rather than being guessed at", () => {
    expect(isNewMoney(row({ kind: "portfolio_income", categoryId: 516, categoryType: "I" }), null)).toBe(false);
    // A Transfer category needs no key to recognise.
    expect(isNewMoney(row({ kind: "portfolio_expense", amount: -50, categoryId: 520, categoryType: "R" }), null)).toBe(true);
  });

  it("never counts a trade or an internal swap, even when linked or Transfer-categorized", () => {
    expect(isNewMoney(row({ kind: "buy", tradeLinkId: "x", amount: 1000, quantity: 10 }), incomeIds)).toBe(false);
    expect(isNewMoney(row({ kind: "buy_cash_leg", tradeLinkId: "x", amount: -1000 }), incomeIds)).toBe(false);
    expect(isNewMoney(row({ kind: "sell_cash_leg", amount: 900, categoryType: "R" }), incomeIds)).toBe(false);
    expect(isNewMoney(row({ kind: "fx_from", linkId: "f", amount: -100 }), incomeIds)).toBe(false);
    expect(isNewMoney(row({ kind: "fx_to", linkId: "f", amount: 72 }), incomeIds)).toBe(false);
  });

  it("counts a security bought or sold in a single row: nothing inside paid for it", () => {
    // The demo's sample data: 10 shares, amount -4,800 (cash convention), no cash leg.
    expect(newMoneyAmount(row({ kind: "buy", onSecurity: true, quantity: 10, amount: -4800 }), incomeIds)).toBe(4800);
    expect(newMoneyAmount(row({ kind: "sell", onSecurity: true, quantity: -1, amount: 500 }), incomeIds)).toBe(-500);
    // An import with no kind and the amount sign flipped: the units decide.
    expect(newMoneyAmount(row({ kind: null, onSecurity: true, quantity: 5, amount: 650 }), incomeIds)).toBe(650);
  });

  it("does not treat a reinvested dividend without a kind as a single-row buy", () => {
    expect(newMoneyAmount(row({ kind: null, onSecurity: true, quantity: 0.2, amount: 30, categoryId: DIVIDENDS, categoryType: "I" }), incomeIds)).toBeNull();
  });

  it("reports the direction of money on every other rule from the amount", () => {
    expect(newMoneyAmount(row({ linkId: "w", amount: -2000 }), incomeIds)).toBe(-2000);
    expect(newMoneyAmount(row({ kind: "portfolio_expense", amount: -14391, categoryType: "R" }), incomeIds)).toBe(-14391);
    expect(newMoneyAmount(row({ kind: "portfolio_income", amount: 22.5, categoryId: 516, categoryType: "I" }), incomeIds)).toBe(22.5);
    expect(newMoneyAmount(row({ kind: "portfolio_income", amount: 30, categoryId: DIVIDENDS, categoryType: "I" }), incomeIds)).toBeNull();
  });

  it("ignores a zero amount", () => {
    expect(isNewMoney(row({ linkId: "z", amount: 0 }), incomeIds)).toBe(false);
  });
});
