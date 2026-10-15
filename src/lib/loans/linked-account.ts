/**
 * Which account a loan may be tracked on (2026-10-14).
 *
 * A linked account's balance BECOMES the loan's balance (`SUM(transactions.amount)`
 * on it), and a loan's interest is booked as an expense on that same account.
 * An investment account fits neither: its ledger is portfolio entries whose sum
 * is net contributions, and `postLoanInterest` refuses to book interest there.
 * So a loan can only be linked to a regular account. Shared by REST
 * `POST/PUT /api/loans` and MCP `manage_loans(op:add|update)`.
 *
 * Only a NEW link is checked: a loan already on an investment account (from
 * before this rule) keeps it, so its other fields stay editable.
 */

import { sql } from "drizzle-orm";
import { normalizeDbRows } from "@/lib/db-utils";
import type { Executor } from "@/lib/delete-blockers";

export const INVESTMENT_LOAN_ACCOUNT_MESSAGE =
  "A loan can't be tracked on an investment account. Pick a regular account (a loan, credit or bank " +
  "account): its balance becomes what you owe, and the loan's interest is booked there.";

/** True when `accountId` is one of the user's investment accounts. */
export async function isInvestmentAccount(db: Executor, userId: string, accountId: number): Promise<boolean> {
  const rows = normalizeDbRows<{ is_investment: unknown }>(
    await db.execute(sql`SELECT is_investment FROM accounts WHERE id = ${accountId} AND user_id = ${userId}`),
  );
  return rows[0]?.is_investment === true;
}

/**
 * The refusal for linking `nextAccountId`, or null when it may be linked:
 * no account, the account the loan already has, or a regular account.
 */
export async function loanAccountRefusal(
  db: Executor,
  userId: string,
  nextAccountId: number | null | undefined,
  currentAccountId: number | null = null,
): Promise<string | null> {
  if (nextAccountId == null || nextAccountId === currentAccountId) return null;
  return (await isInvestmentAccount(db, userId, nextAccountId)) ? INVESTMENT_LOAN_ACCOUNT_MESSAGE : null;
}
