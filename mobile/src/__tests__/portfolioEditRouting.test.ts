import {
  PORTFOLIO_OP_FOR_KIND,
  isMobileEditableOp,
  isPortfolioKind,
  isPortfolioRow,
  portfolioOpForKind,
} from "../lib/portfolio/edit-routing";

describe("portfolio edit routing", () => {
  it("maps each portfolio kind to the web's operation form", () => {
    expect(portfolioOpForKind("buy_cash_leg")).toBe("buy");
    expect(portfolioOpForKind("sell")).toBe("sell");
    expect(portfolioOpForKind("brokerage_deposit_out")).toBe("deposit");
    expect(portfolioOpForKind("brokerage_deposit_in")).toBe("deposit");
    expect(portfolioOpForKind("brokerage_withdrawal_in")).toBe("withdrawal");
    expect(portfolioOpForKind("in_kind_transfer_out")).toBe("transfer");
    expect(portfolioOpForKind("fx_fee")).toBe("fx-conversion");
    expect(portfolioOpForKind("portfolio_expense")).toBe("income-expense");
  });

  it("treats plain and unknown kinds as not portfolio ops", () => {
    expect(portfolioOpForKind(null)).toBeNull();
    expect(portfolioOpForKind("transfer")).toBeNull();
    expect(portfolioOpForKind("opening_balance")).toBeNull();
    expect(portfolioOpForKind("toString")).toBeNull(); // no prototype leaks
    expect(isPortfolioKind("dividend")).toBe(false);
  });

  it("has a form in the app for every mapped operation", () => {
    for (const op of Object.values(PORTFOLIO_OP_FOR_KIND)) expect(isMobileEditableOp(op)).toBe(true);
    expect(isMobileEditableOp("swap")).toBe(true);
    expect(isMobileEditableOp("rebalance")).toBe(false);
    expect(isMobileEditableOp(undefined)).toBe(false);
  });

  it("recognises a portfolio row by kind, holding link or quantity", () => {
    expect(isPortfolioRow({ kind: "brokerage_deposit_out" })).toBe(true);
    expect(isPortfolioRow({ portfolioHoldingId: 9, portfolioHolding: null })).toBe(true);
    expect(isPortfolioRow({ portfolioHolding: "VFV" })).toBe(true);
    expect(isPortfolioRow({ quantity: 3 })).toBe(true);
    expect(isPortfolioRow({ kind: "transfer", quantity: 0, portfolioHoldingId: null })).toBe(false);
    expect(isPortfolioRow({})).toBe(false);
  });
});
