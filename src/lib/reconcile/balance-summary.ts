/**
 * Bank-vs-system balance comparison (extracted FINLYNQ-215, 2026-06-25).
 *
 * Single source of truth for the "/import reconcile header" balance check —
 * the number the user sees as the per-account balance delta. Lifted VERBATIM
 * (same math, same EPSILON, same sign) out of
 * `GET /api/reconcile/balance-summary` so that route AND the MCP
 * `get_reconciliation_summary` tool (FINLYNQ-215) compute the identical delta.
 * Do NOT re-derive this anywhere; reuse `computeAccountBalanceSummary`.
 *
 * For each account:
 *   - latestAnchor    = most recent bank_daily_balances row, or null.
 *   - bankSideLatest  = latestAnchor.balance + Σ(bank_tx.amount where
 *                       date > latestAnchor.date). Null when no anchor (the
 *                       naive sum-from-zero is meaningless and misleads).
 *   - systemSideLatest= canonical account balance per CLAUDE.md "Account
 *                       balance for accounts with holdings = holdings.value":
 *                         investment → getHoldingsValueByAccount[id].value
 *                         cash       → SUM(transactions.amount)
 *   - delta           = systemSideLatest − bankSideLatest, or null when
 *                       bankSide is null (no anchor). This is the figure the
 *                       /import reconcile header renders; a positive delta means
 *                       the system/ledger says MORE than the bank statement.
 *   - status          = 'balanced' | 'mismatch' | 'no_anchor'.
 */

import { db, schema } from "@/db";
import { and, eq, sql } from "drizzle-orm";
import {
  getLatestBankAnchor,
  sumBankAmountsAfter,
} from "@/lib/bank-ledger-balance";
import { getHoldingsValueByAccount } from "@/lib/holdings-value";

/** Float tolerance for the "balanced" check. Mirrors the threshold used by
 *  the validation helper + queries.ts account-balance code. */
export const BALANCE_SUMMARY_EPSILON = 0.005;

export interface AccountBalanceSummary {
  accountId: number;
  currency: string;
  latestAnchor: {
    date: string;
    balance: number;
    source: string;
    currency: string;
  } | null;
  /** Anchor projected forward to today's bank-side balance. Null = no anchor. */
  bankSideLatest: number | null;
  /** Canonical system/ledger balance (holdings.value for investment accounts). */
  systemSideLatest: number;
  /** systemSideLatest − bankSideLatest. Null when bankSideLatest is null.
   *  This is the /import reconcile header's delta — reuse it verbatim. */
  delta: number | null;
  status: "balanced" | "mismatch" | "no_anchor";
}

export interface BalanceSummaryAccount {
  id: number;
  currency: string;
  isInvestment: boolean;
}

/**
 * Compute the bank-vs-system balance summary for ONE account.
 *
 * Pass `holdingsByAccount` (the result of `getHoldingsValueByAccount`) to skip
 * the per-account holdings recompute when summarizing many accounts in a batch;
 * omit it for the single-account route path (this fn fetches it lazily only
 * when the account is an investment account and no map was supplied).
 */
export async function computeAccountBalanceSummary(
  userId: string,
  dek: Buffer | null,
  account: BalanceSummaryAccount,
  holdingsByAccount?: Map<number, { value: number }>,
): Promise<AccountBalanceSummary> {
  const latestAnchor = await getLatestBankAnchor(userId, account.id);

  let bankSideLatest: number | null;
  if (latestAnchor) {
    const after = await sumBankAmountsAfter(userId, account.id, latestAnchor.date);
    bankSideLatest = latestAnchor.balance + after;
  } else {
    bankSideLatest = null;
  }

  let systemSideLatest: number;
  if (account.isInvestment) {
    const map =
      holdingsByAccount ?? (await getHoldingsValueByAccount(userId, dek));
    systemSideLatest = map.get(account.id)?.value ?? 0;
  } else {
    const sumRow = await db
      .select({
        balance: sql<number>`COALESCE(SUM(${schema.transactions.amount}), 0)`,
      })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.userId, userId),
          eq(schema.transactions.accountId, account.id),
        ),
      )
      .get();
    systemSideLatest = Number(sumRow?.balance ?? 0);
  }

  const delta: number | null =
    bankSideLatest === null ? null : systemSideLatest - bankSideLatest;
  const status: AccountBalanceSummary["status"] = (() => {
    if (!latestAnchor || delta === null) return "no_anchor";
    if (Math.abs(delta) > BALANCE_SUMMARY_EPSILON) return "mismatch";
    return "balanced";
  })();

  return {
    accountId: account.id,
    currency: account.currency,
    latestAnchor,
    bankSideLatest,
    systemSideLatest,
    delta,
    status,
  };
}
