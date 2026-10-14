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
 *               Also a security bought or sold in a SINGLE row (no trade
 *               link, no cash leg): nothing inside the portfolio paid for
 *               it, so the shares arrived from outside, or the proceeds left.
 *               The demo's sample data and some imports record trades that
 *               way; prod had 21 such rows, none with a matching cash row.
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
  /** The row sits on a security (not a cash sleeve, not a plain cash account). */
  onSecurity?: boolean;
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
 * The new money a row brings in (+) or takes out (−), in the row's own
 * currency, or null when the row is return (or nothing at all).
 *
 * @param investmentIncomeCategoryIds the user's Dividends / Interest category
 *   ids, or null when they can't be resolved (no key): then categorized income
 *   is never treated as new money.
 */
export function newMoneyAmount(
  row: FlowRow,
  investmentIncomeCategoryIds: ReadonlySet<number> | null,
): number | null {
  if (row.kind === "buy_cash_leg" || row.kind === "sell_cash_leg") return null;
  if (isInternalSwapKind(row.kind)) return null;
  // A trade: cash for a security (or back) inside the account.
  if (row.tradeLinkId != null) return null;
  if (row.amount === 0) return null;
  // On the investment account's leg the amount's sign is the direction:
  // + money arriving, − money leaving.
  if (row.linkId != null) return row.amount;
  if (row.kind != null && NEW_MONEY_KINDS.has(row.kind)) return row.amount;
  if (row.categoryType === "R") return row.amount;
  const investmentIncome =
    row.categoryId != null && investmentIncomeCategoryIds != null && investmentIncomeCategoryIds.has(row.categoryId);
  if (
    row.kind === "portfolio_income" &&
    row.categoryId != null &&
    investmentIncomeCategoryIds != null &&
    !investmentIncome
  ) {
    return row.amount;
  }
  // A single-row trade: shares in or out with nothing paying for them inside
  // the portfolio. Its amount's sign follows the cash convention (a buy is
  // negative), so the direction comes from the units instead.
  if (
    row.onSecurity &&
    row.quantity != null &&
    row.quantity !== 0 &&
    (row.kind == null || row.kind === "buy" || row.kind === "sell") &&
    !investmentIncome
  ) {
    return Math.sign(row.quantity) * Math.abs(row.amount);
  }
  return null;
}

/** True when the row is new money rather than return. */
export function isNewMoney(
  row: FlowRow,
  investmentIncomeCategoryIds: ReadonlySet<number> | null,
): boolean {
  return newMoneyAmount(row, investmentIncomeCategoryIds) !== null;
}
