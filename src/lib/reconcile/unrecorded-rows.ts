/**
 * The ONE definition of "this bank-ledger row was never recorded as a
 * transaction" (GH #332).
 *
 * Two surfaces make this same claim and they must agree, because one links to
 * the other:
 *   - `pendingCount` in [summary.ts](./summary.ts) — the per-account badge on
 *     the /import reconcile panel, and MCP `get_reconciliation_summary`.
 *   - `getUnrecordedBankRows` in [spotlight.ts](../spotlight.ts) — the
 *     dashboard Action Center card, whose "View" deep-links straight to that
 *     panel. A card reading "9 rows awaiting recording" next to a panel showing
 *     a different number is worse than not surfacing it at all.
 *
 * ─── "Recorded" means A LINK EXISTS, never "the legacy FK is set" ───────────
 *
 * This shipped (2026-08-22) as an anti-join on `transactions.bank_transaction_id`
 * and that was WRONG — it over-counted by 59% on the reporter's own data (818
 * claimed, 486 of them already reconciled). `linkTransactionToBank`
 * ([links.ts](./links.ts)) sets that FK only when `link_type='primary'` AND the
 * transaction's FK is still NULL, so two ordinary outcomes never set it:
 *
 *   - an `extra` link — and `POST /api/reconcile/links` DEFAULTS `linkType` to
 *     `'extra'` while the bulk route accepts nothing else, so this is the
 *     dominant write path, not an edge case (467 rows on the reporter's data);
 *   - a `primary` link onto a transaction whose FK already points at a
 *     different bank row, i.e. one transaction reconciled against several
 *     statement lines (34 rows).
 *
 * The reconcile UI has always read the join table
 * ([inbox-reconcile-tab.tsx](../../components/inbox/inbox-reconcile-tab.tsx)):
 * ANY link badges `linked_primary`/`linked_extra`, and only a link-less row is
 * `bank_only`. The FK-based count could therefore never agree with the screen
 * it deep-links to. `transaction_bank_links` is the source of truth; the FK is
 * a denormalized convenience pointer for the primary link alone.
 *
 * This also aligns the cheap predicate with `bankOnly` from
 * `getReconciliationSummary`, which derives its counts from the real match
 * engine — those two now answer the same question.
 *
 * Kept in its own leaf module rather than exported from `summary.ts` on
 * purpose: `summary.ts` imports the reconcile match-engine, balance-summary and
 * holdings-value, and the Action Center is on the dashboard's hot path — it
 * should not drag the whole matcher in behind a one-line predicate.
 *
 * Callers supply their own `user_id` scope; this is the lineage check only.
 */

import { schema } from "@/db";
import { sql } from "drizzle-orm";

export function unrecordedBankRowSql() {
  return sql`NOT EXISTS (SELECT 1 FROM transaction_bank_links l WHERE l.bank_transaction_id = ${schema.bankTransactions.id})`;
}
