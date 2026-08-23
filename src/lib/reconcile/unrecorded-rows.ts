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
  return sql`NOT EXISTS (SELECT 1 FROM transactions t WHERE t.bank_transaction_id = ${schema.bankTransactions.id})`;
}
