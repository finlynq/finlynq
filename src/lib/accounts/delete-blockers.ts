/**
 * Pre-flight check for deleting an `accounts` row.
 *
 * `accounts` is referenced by 20 foreign keys. Ten of them are ON DELETE NO
 * ACTION and therefore REFUSE the delete with a Postgres 23503; the other ten
 * cascade (or SET NULL) and clean themselves up. Both delete surfaces — the
 * REST `DELETE /api/accounts` route and the MCP `manage_accounts(op:"delete")`
 * tool — call this FIRST so that:
 *
 *   1. the caller gets a readable message naming what is actually in the way,
 *      instead of a raw foreign-key violation (the MCP tool surfaced the bare
 *      Postgres text; the REST route turned it into a generic 409), and
 *   2. the doomed DELETE never reaches Postgres at all. Every attempt was
 *      landing in `diagnostics_log` as a db_error — four of them inside five
 *      minutes on prod (2026-07-24) as one user retried across both surfaces.
 *
 * We do NOT clear the blocking rows on the caller's behalf. Transactions in
 * particular are never removed as a side effect of another feature (see the
 * "no programmatic transaction deletes" rule in CLAUDE.md). Archiving the
 * account — `PUT /api/accounts { archived: true }` — is the supported way to
 * retire an account that has history, and is what both surfaces now suggest.
 *
 * KEEP `BLOCKERS` AND THE SELECT BELOW IN LOCKSTEP WITH THE SCHEMA. A new
 * NO ACTION foreign key to `accounts` that is missing here will 23503 at
 * delete time exactly the way `portfolio_holdings` did.
 */

import { sql } from "drizzle-orm";
import { normalizeDbRows } from "../db-utils";

/**
 * Minimal structural type satisfied by BOTH the app's Drizzle proxy (`@/db`)
 * and the MCP tool context's `DbLike` (mcp-server/tools/_shared.ts), so the
 * one helper serves both surfaces without either importing the other.
 */
type Executor = { execute: (query: ReturnType<typeof sql>) => Promise<unknown> };

export interface AccountDeleteBlocker {
  /** Table holding the rows that block the delete. */
  table: string;
  /** Singular human-readable noun, for message building. */
  label: string;
  count: number;
}

/**
 * The ten ON DELETE NO ACTION referents, in the order they are reported.
 * `table` doubles as the column alias in the SELECT below.
 */
const BLOCKERS: ReadonlyArray<{ table: string; label: string }> = [
  { table: "transactions", label: "transaction" },
  { table: "portfolio_holdings", label: "investment holding" },
  { table: "loans", label: "loan" },
  { table: "goals", label: "goal" },
  { table: "subscriptions", label: "subscription" },
  { table: "recurring_transactions", label: "recurring transaction" },
  { table: "transaction_splits", label: "transaction split" },
  { table: "snapshots", label: "snapshot" },
  { table: "staged_imports", label: "staged import" },
  { table: "staged_transactions", label: "staged transaction" },
];

/**
 * Count every row that would refuse a delete of `accountId`, in ONE round trip.
 * Returns only the non-empty blockers, in `BLOCKERS` order. An empty array
 * means the delete is safe to attempt.
 *
 * `transaction_splits` has no `user_id` column, so it is scoped by account
 * alone — safe because both callers resolve the account owner-scoped before
 * asking. `staged_imports` and `staged_transactions` reference the account
 * under non-obvious column names (`bound_account_id` / `target_account_id`).
 */
export async function getAccountDeleteBlockers(
  db: Executor,
  userId: string,
  accountId: number,
): Promise<AccountDeleteBlocker[]> {
  const rows = normalizeDbRows<Record<string, unknown>>(
    await db.execute(sql`
      SELECT
        (SELECT COUNT(*) FROM transactions WHERE user_id = ${userId} AND account_id = ${accountId}) AS transactions,
        (SELECT COUNT(*) FROM portfolio_holdings WHERE user_id = ${userId} AND account_id = ${accountId}) AS portfolio_holdings,
        (SELECT COUNT(*) FROM loans WHERE user_id = ${userId} AND account_id = ${accountId}) AS loans,
        (SELECT COUNT(*) FROM goals WHERE user_id = ${userId} AND account_id = ${accountId}) AS goals,
        (SELECT COUNT(*) FROM subscriptions WHERE user_id = ${userId} AND account_id = ${accountId}) AS subscriptions,
        (SELECT COUNT(*) FROM recurring_transactions WHERE user_id = ${userId} AND account_id = ${accountId}) AS recurring_transactions,
        (SELECT COUNT(*) FROM transaction_splits WHERE account_id = ${accountId}) AS transaction_splits,
        (SELECT COUNT(*) FROM snapshots WHERE user_id = ${userId} AND account_id = ${accountId}) AS snapshots,
        (SELECT COUNT(*) FROM staged_imports WHERE user_id = ${userId} AND bound_account_id = ${accountId}) AS staged_imports,
        (SELECT COUNT(*) FROM staged_transactions WHERE user_id = ${userId} AND target_account_id = ${accountId}) AS staged_transactions
    `),
  );
  const counts = rows[0] ?? {};
  return BLOCKERS.map((b) => ({
    table: b.table,
    label: b.label,
    count: Number(counts[b.table] ?? 0),
  })).filter((b) => b.count > 0);
}

/** `"10 transactions, 8 investment holdings and 1 goal"`. */
export function describeAccountDeleteBlockers(blockers: AccountDeleteBlocker[]): string {
  const parts = blockers.map((b) => `${b.count} ${b.label}${b.count === 1 ? "" : "s"}`);
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * The single user-facing refusal message, shared by the REST route and the MCP
 * tool so both surfaces explain the same thing the same way.
 */
export function accountDeleteBlockedMessage(blockers: AccountDeleteBlocker[]): string {
  return (
    `This account still has ${describeAccountDeleteBlockers(blockers)} linked to it, ` +
    `so it cannot be deleted. Archive the account instead, or remove the linked ` +
    `records first.`
  );
}
