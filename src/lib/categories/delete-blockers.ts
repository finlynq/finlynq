/**
 * Pre-flight check for deleting a `categories` row — the sibling of
 * [accounts/delete-blockers.ts](../accounts/delete-blockers.ts), and the same
 * lesson learned twice.
 *
 * `categories` is referenced by 8 foreign keys. SIX are ON DELETE NO ACTION and
 * therefore refuse the delete with a Postgres 23503:
 *
 *   transactions, budgets, recurring_transactions, subscriptions,
 *   budget_templates, transaction_splits
 *
 * The other two are ON DELETE SET NULL and clean themselves up
 * (`backfill_proposals.chosen_category_id`, `email_import_rules.category_id`),
 * so they are deliberately NOT listed here.
 *
 * The DELETE route used to pre-check `transactions` ALONE, which is why a
 * category attached to a budget escaped as a raw foreign-key violation — prod
 * 2026-07-24 20:01 UTC, `budgets_category_id_fkey`, from a handler with no
 * try/catch at all.
 *
 * As with accounts, we do NOT clear the blocking rows on the caller's behalf —
 * transactions in particular are never removed as a side effect of another
 * feature (the "no programmatic transaction deletes" rule in CLAUDE.md).
 *
 * KEEP `BLOCKERS` AND THE SELECT BELOW IN LOCKSTEP WITH THE SCHEMA. A new
 * NO ACTION foreign key to `categories` that is missing here will 23503 at
 * delete time exactly the way `budgets` did.
 */

import { sql } from "drizzle-orm";
import { normalizeDbRows } from "../db-utils";
import {
  collectBlockers,
  describeDeleteBlockers,
  type DeleteBlocker,
  type Executor,
} from "../delete-blockers";

export type CategoryDeleteBlocker = DeleteBlocker;

/**
 * The six ON DELETE NO ACTION referents, in the order they are reported.
 * `table` doubles as the column alias in the SELECT below.
 */
const BLOCKERS: ReadonlyArray<{ table: string; label: string }> = [
  { table: "transactions", label: "transaction" },
  { table: "budgets", label: "budget" },
  { table: "budget_templates", label: "budget template" },
  { table: "recurring_transactions", label: "recurring transaction" },
  { table: "subscriptions", label: "subscription" },
  { table: "transaction_splits", label: "transaction split" },
];

/**
 * Count every row that would refuse a delete of `categoryId`, in ONE round
 * trip. Returns only the non-empty blockers, in `BLOCKERS` order. An empty
 * array means the delete is safe to attempt.
 *
 * `transaction_splits` has no `user_id` column, so it is scoped by category
 * alone — safe because the caller resolves the category owner-scoped first.
 */
export async function getCategoryDeleteBlockers(
  db: Executor,
  userId: string,
  categoryId: number,
): Promise<CategoryDeleteBlocker[]> {
  const rows = normalizeDbRows<Record<string, unknown>>(
    await db.execute(sql`
      SELECT
        (SELECT COUNT(*) FROM transactions WHERE user_id = ${userId} AND category_id = ${categoryId}) AS transactions,
        (SELECT COUNT(*) FROM budgets WHERE user_id = ${userId} AND category_id = ${categoryId}) AS budgets,
        (SELECT COUNT(*) FROM budget_templates WHERE user_id = ${userId} AND category_id = ${categoryId}) AS budget_templates,
        (SELECT COUNT(*) FROM recurring_transactions WHERE user_id = ${userId} AND category_id = ${categoryId}) AS recurring_transactions,
        (SELECT COUNT(*) FROM subscriptions WHERE user_id = ${userId} AND category_id = ${categoryId}) AS subscriptions,
        (SELECT COUNT(*) FROM transaction_splits WHERE category_id = ${categoryId}) AS transaction_splits
    `),
  );
  return collectBlockers(rows[0] ?? {}, BLOCKERS);
}

/**
 * The single user-facing refusal message. Unlike accounts there is no "archive
 * it instead" escape hatch for categories, so this points at re-categorizing.
 */
export function categoryDeleteBlockedMessage(blockers: CategoryDeleteBlocker[]): string {
  return (
    `This category is still used by ${describeDeleteBlockers(blockers)}, so it ` +
    `cannot be deleted. Move those records to a different category first.`
  );
}
