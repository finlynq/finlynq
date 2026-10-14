/**
 * Which investment-account transactions are NEW MONEY (put in or taken out)
 * rather than RETURN. Pure — no DB.
 *
 * Performance (TWRR and XIRR) must strip new money out, or a deposit reads as
 * a gain and a withdrawal as a loss. Until 2026-10-14 only `link_id` transfer
 * legs counted. Everything else that moves money across the portfolio's edge
 * was scored as return: measured on one real portfolio, the stored
 * contributions for a year totalled 19k while cost basis grew 71k, and the
 * reported 1Y TWRR was 30.6%.
 *
 * Owner's rule (2026-10-14):
 *   New money:  transfer legs (link_id) as before, brokerage deposits and
 *               withdrawals, opening balances, balance adjustments, anything
 *               categorized as a Transfer (category type R), and reinvested
 *               income ("portfolio_income") whose category is NOT an
 *               investment-income one (Dividends / Interest) — e.g. payroll
 *               contributions to a group plan booked as reinvested units.
 *   Return:     dividends, interest, fees, price moves.
 *
 * Never new money, whatever its category: a trade (either leg, it only swaps
 * cash for a security inside the account) and internal swaps (FX conversions,
 * in-kind moves between the user's own accounts — FINLYNQ-254).
 *
 * Uncategorized income stays RETURN: dividends often arrive uncategorized, and
 * calling them new money would understate performance. Without the user's key
 * the investment-income categories can't be identified by name, so the caller
 * passes `null` and all categorized income is treated as return (the old
 * behaviour) rather than guessed at.
 */

import { isInternalSwapKind } from "../aggregation-predicates";

export interface FlowRow {
  kind: string | null;
  linkId: string | null;
  tradeLinkId: string | null;
  amount: number;
  quantity: number | null;
  categoryId: number | null;
  /** categories.type: "E" | "I" | "R", null when uncategorized. */
  categoryType: string | null;
}

/** Kinds that bring money in or take it out on their own, linked or not. */
export const NEW_MONEY_KINDS: ReadonlySet<string> = new Set([
  "opening_balance",
  "balance_adjustment",
  "brokerage_deposit_in",
  "brokerage_withdrawal_out",
]);

/**
 * @param investmentIncomeCategoryIds the user's Dividends / Interest category
 *   ids, or null when they can't be resolved (no key): then categorized income
 *   is never treated as new money.
 */
export function isNewMoney(
  row: FlowRow,
  investmentIncomeCategoryIds: ReadonlySet<number> | null,
): boolean {
  if (row.kind === "buy_cash_leg" || row.kind === "sell_cash_leg") return false;
  if (isInternalSwapKind(row.kind)) return false;
  // A trade: cash for a security (or back) inside the account.
  if (row.tradeLinkId != null) return false;
  if (row.amount === 0) return false;
  if (row.linkId != null) return true;
  if (row.kind != null && NEW_MONEY_KINDS.has(row.kind)) return true;
  if (row.categoryType === "R") return true;
  if (
    row.kind === "portfolio_income" &&
    row.categoryId != null &&
    investmentIncomeCategoryIds != null &&
    !investmentIncomeCategoryIds.has(row.categoryId)
  ) {
    return true;
  }
  return false;
}
