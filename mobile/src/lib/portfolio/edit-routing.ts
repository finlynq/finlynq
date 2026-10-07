// Which rows are edited as PORTFOLIO OPERATIONS rather than through the
// generic single-row edit. A portfolio op writes two (or more) linked rows —
// a stock leg and a cash leg, both sides of a brokerage deposit, the legs of
// an FX conversion — so editing one row on its own would leave its siblings
// stale; the server now refuses amount / account / date changes to a linked
// leg anyway. Mirrors the web's `startEdit` in transactions-workspace.tsx,
// which sends every one of these kinds to /portfolio/new?op=…&editId=….
import type { PortfolioOpKey } from "../../../../shared/types";
import { OP_CONFIGS } from "./operations";

/** `transactions.kind` → the operation form that edits it (the web's map). */
export const PORTFOLIO_OP_FOR_KIND: Readonly<Record<string, PortfolioOpKey>> = {
  buy: "buy",
  buy_cash_leg: "buy",
  sell: "sell",
  sell_cash_leg: "sell",
  in_kind_transfer_in: "transfer",
  in_kind_transfer_out: "transfer",
  fx_from: "fx-conversion",
  fx_to: "fx-conversion",
  fx_fee: "fx-conversion",
  portfolio_income: "income-expense",
  portfolio_expense: "income-expense",
  brokerage_deposit_in: "deposit",
  brokerage_deposit_out: "deposit",
  brokerage_withdrawal_in: "withdrawal",
  brokerage_withdrawal_out: "withdrawal",
};

/** The operation a row's kind belongs to, or null for a plain row. */
export function portfolioOpForKind(kind: string | null | undefined): PortfolioOpKey | null {
  if (!kind) return null;
  return Object.prototype.hasOwnProperty.call(PORTFOLIO_OP_FOR_KIND, kind) ? PORTFOLIO_OP_FOR_KIND[kind] : null;
}

export function isPortfolioKind(kind: string | null | undefined): boolean {
  return portfolioOpForKind(kind) != null;
}

/** True when the app's OperationForm can edit this op (anything else: use the web). */
export function isMobileEditableOp(op: string | null | undefined): op is PortfolioOpKey {
  return !!op && Object.prototype.hasOwnProperty.call(OP_CONFIGS, op);
}

/**
 * A row that belongs to a portfolio operation: a portfolio kind, a holding
 * link (by id, so it still holds when a cold DEK leaves the name null), or a
 * share quantity.
 */
export function isPortfolioRow(row: {
  kind?: string | null;
  quantity?: number | null;
  portfolioHoldingId?: number | null;
  portfolioHolding?: string | null;
}): boolean {
  return (
    isPortfolioKind(row.kind) ||
    row.portfolioHoldingId != null ||
    row.portfolioHolding != null ||
    (row.quantity != null && row.quantity !== 0)
  );
}
