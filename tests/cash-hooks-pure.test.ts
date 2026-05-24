/**
 * Pure-unit tests for Phase 5c cash-sleeve lot tracking helpers.
 *
 * Lives alongside the existing pure tests so it runs without bootstrapping
 * the Postgres harness. The DB-touching cash hook behavior (open/close lots
 * across FX conversions, brokerage moves, etc.) is exercised by the
 * portfolio-fixture suite when a Postgres test instance is available.
 */

import { describe, it, expect } from "vitest";
import { inferCashCloseKind } from "@/lib/portfolio/lots/cash-hooks";

describe("inferCashCloseKind", () => {
  it("maps fx_from / fx_to to 'fx_conversion'", () => {
    expect(inferCashCloseKind("fx_from")).toBe("fx_conversion");
    expect(inferCashCloseKind("fx_to")).toBe("fx_conversion");
  });

  it("maps portfolio_expense to 'income_expense'", () => {
    expect(inferCashCloseKind("portfolio_expense")).toBe("income_expense");
  });

  it("maps buy_cash_leg / sell_cash_leg / brokerage_withdrawal_out to 'buy_sell'", () => {
    expect(inferCashCloseKind("buy_cash_leg")).toBe("buy_sell");
    expect(inferCashCloseKind("sell_cash_leg")).toBe("buy_sell");
    expect(inferCashCloseKind("brokerage_withdrawal_out")).toBe("buy_sell");
  });

  it("falls back to 'buy_sell' for null / unknown kinds", () => {
    expect(inferCashCloseKind(null)).toBe("buy_sell");
    expect(inferCashCloseKind(undefined)).toBe("buy_sell");
    expect(inferCashCloseKind("unknown_kind")).toBe("buy_sell");
  });
});
