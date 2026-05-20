/**
 * Auto-match candidate finder for the two-pane reconciliation UI on
 * `/import/pending` (FINLYNQ-56). Given decoded staged rows + decoded
 * existing transactions in the ±7-day window around the staged batch's
 * date range, return every (staged, db) pair that could plausibly be the
 * same real-world transaction.
 *
 * The matcher is pure (no DB I/O, no DEK) so the GET staged-detail route
 * can call it after decoding rows in-memory. Both inputs are pre-filtered
 * for user-scoping by the caller.
 *
 * Match window (user decision 2026-05-20):
 *   - same accountId
 *   - same currency (cross-currency rows stay 'unmatched' — by design)
 *   - |Δamount| ≤ 0.01    (rounded-cent statement totals; FX-leg drift)
 *   - |Δdate|   ≤ 1 day   (FX legs that post the next business day)
 *
 * Multi-candidate behaviour: surface all matches. Two same-day same-amount
 * DB rows (e.g. two $20 ATMs) produce two separate suggestions so the user
 * can pick. The SuggestionsGroup renders each as a discrete accept/reject
 * pair.
 *
 * Confidence labels:
 *   - 'exact' = date AND amount match exactly (the cheap, high-trust case)
 *   - 'fuzzy' = within tolerance but not bit-identical (user verifies)
 */

export interface AutoMatchStagedRow {
  id: string;
  date: string; // YYYY-MM-DD
  amount: number;
  currency: string;
  reconcileState: string;
  accountId: number | null;
}

export interface AutoMatchDbRow {
  id: number;
  date: string; // YYYY-MM-DD
  amount: number;
  currency: string;
  accountId: number;
  /** True if some staged_transactions.linked_transaction_id already
   *  points at this DB row — exclude from candidates to avoid surfacing
   *  the same DB row to two staged rows. */
  alreadyLinked: boolean;
}

export interface AutoMatchSuggestion {
  stagedRowId: string;
  transactionId: number;
  confidence: "exact" | "fuzzy";
}

/** Whole-day delta between two YYYY-MM-DD strings. */
function dayDiff(a: string, b: string): number {
  const ms = Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z");
  return Math.round(ms / 86_400_000);
}

export function findAutoMatches(input: {
  staged: AutoMatchStagedRow[];
  db: AutoMatchDbRow[];
}): AutoMatchSuggestion[] {
  const eligibleDb = input.db.filter((d) => !d.alreadyLinked);
  const out: AutoMatchSuggestion[] = [];

  for (const s of input.staged) {
    if (s.reconcileState === "linked" || s.reconcileState === "skipped_duplicate") {
      continue;
    }
    if (s.accountId == null) continue;

    for (const d of eligibleDb) {
      if (d.accountId !== s.accountId) continue;
      if (d.currency !== s.currency) continue;
      if (Math.abs(d.amount - s.amount) > 0.01) continue;
      if (Math.abs(dayDiff(d.date, s.date)) > 1) continue;

      const confidence: "exact" | "fuzzy" =
        d.date === s.date && Math.abs(d.amount - s.amount) < 1e-9
          ? "exact"
          : "fuzzy";

      out.push({
        stagedRowId: s.id,
        transactionId: d.id,
        confidence,
      });
    }
  }

  return out;
}
