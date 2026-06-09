/**
 * Pure bank-ledger staging projection for the /import Staging banner (FINLYNQ-124).
 *
 * The Staging-tab balance banner (`ReconciliationCallout`) used to show a
 * SYSTEM-ledger projection ("Statement says / Finlynq has now / After
 * approval") that duplicated the Reconcile tab and went dead after send. In
 * the detailed/manual flow, "Send to bank ledger" writes ONLY to
 * `bank_transactions` — never `transactions` — so projecting staged rows onto
 * the system-ledger balance was meaningless.
 *
 * These two helpers feed the reframed banner ("Statement says / Bank ledger
 * has / After sending N rows"):
 *   - `latestBankLedgerBalance(dbRows)` → the left pane's running total, i.e.
 *     the `runningBalance` of the LATEST-DATED bank-ledger row (what staged
 *     rows actually land into). Null when no row carries a runningBalance.
 *   - `sendableDelta(rows, selected)` → the count + summed amount of the
 *     staged rows the Send button will actually write, using the SAME
 *     eligibility filter as the old client `liveProjection` and the server
 *     `pendingDelta`: `selected && dedupStatus!=='existing' &&
 *     reconcileState ∉ {'skipped_duplicate','linked'}`.
 *
 * PURE — no React, no fetch, no DB. The `DbTransactionRow` import is TYPE-ONLY
 * so this module never drags `@/db` (or the bank-ledger pane component) into
 * the client bundle: a value import would fail `next build` even though tsc
 * passes (the headline build risk this helper was extracted to dodge).
 *
 * Currency is intentionally NOT handled here: OFX/QFX is always same-currency
 * and the common CSV case too. The banner compares numerically and displays in
 * `statementCurrency ?? boundAccountCurrency` — the documented "user is the
 * judge" same-currency assumption. Cross-currency FX of the bank-ledger figure
 * is out of scope.
 */

import type { DbTransactionRow } from "@/components/import/reconcile/db-pane";

/**
 * Minimal structural shape of a staged row for the send projection. Kept local
 * (not an import of `StagedEditableRow`) so this helper stays dependency-free
 * and trivially testable — only the three fields the eligibility filter reads
 * are required.
 */
export interface SendableStagedRow {
  id: string;
  amount: number;
  dedupStatus?: "new" | "existing" | "probable_duplicate";
  reconcileState?: "unmatched" | "auto_suggested" | "linked" | "skipped_duplicate";
}

export interface SendableDelta {
  /** How many eligible rows the Send button will write to the bank ledger. */
  count: number;
  /** Summed signed amount of those rows. */
  delta: number;
}

/**
 * Running balance of the LATEST-DATED bank-ledger row — what staged rows land
 * into. Picks by max `date` (lexicographic on YYYY-MM-DD, which sorts
 * chronologically) so out-of-order input still resolves the right row. Rows
 * whose `runningBalance` is null/undefined are skipped; returns null when no
 * row carries a runningBalance at all (e.g. an account with no anchor yet).
 */
export function latestBankLedgerBalance(
  dbRows: readonly DbTransactionRow[],
): number | null {
  let bestDate: string | null = null;
  let bestBalance: number | null = null;
  for (const r of dbRows) {
    if (r.runningBalance == null) continue;
    if (bestDate == null || r.date > bestDate) {
      bestDate = r.date;
      bestBalance = r.runningBalance;
    }
  }
  return bestBalance;
}

/**
 * Count + summed amount of the staged rows the Send button will actually write
 * into the bank ledger. Eligibility mirrors the old client `liveProjection`
 * and the server `pendingDelta` exactly:
 *   selected && dedupStatus !== 'existing'
 *            && reconcileState !== 'skipped_duplicate'
 *            && reconcileState !== 'linked'
 * Empty selection → `{ count: 0, delta: 0 }`.
 */
export function sendableDelta(
  rows: readonly SendableStagedRow[],
  selected: ReadonlySet<string>,
): SendableDelta {
  let count = 0;
  let delta = 0;
  for (const r of rows) {
    if (!selected.has(r.id)) continue;
    if (r.dedupStatus === "existing") continue;
    if (r.reconcileState === "skipped_duplicate") continue;
    if (r.reconcileState === "linked") continue;
    count += 1;
    delta += Number(r.amount ?? 0);
  }
  return { count, delta };
}
