/**
 * Strict ledger-duplicate detection for the email-import record path (2026-06-18).
 *
 * The exact-hash dedup (`generateImportHash` over date|account|amount|payee)
 * only catches a byte-identical re-import. It misses the common real cases:
 *   - the SAME alert delivered twice on different days (received-date drift),
 *   - an email alert whose parsed payee differs from a transaction the user
 *     already entered by hand / imported from a statement.
 *
 * This mirrors the strict possible-duplicate index the reconcile match-engine
 * uses for Auto-pilot / Approve-each (src/lib/reconcile/match-engine.ts
 * `strictDupFor`): an existing transaction on the SAME account with an
 * identical amount (±$0.01) within `toleranceDays` of the candidate date.
 *
 * PURE — no DB / clock / network. The caller fetches the candidate window of
 * existing transactions and passes them in, so this stays unit-testable.
 */

/**
 * Date window (in days) for the amount-match. Deliberately tighter than the
 * reconcile default (7) because the email auto-record path is silent-create:
 * a window wide enough to collide with a genuinely-distinct same-amount
 * transaction would suppress real income. 4 days still catches a same-week
 * re-send (the 06-05 / 06-06 case) and a manual entry a couple of days off.
 */
export const EMAIL_DEDUP_DATE_TOLERANCE_DAYS = 4;

export interface DedupTxRow {
  id: number;
  /** YYYY-MM-DD. */
  date: string;
  /** Signed amount in the account currency. */
  amount: number;
}

/** Shift a YYYY-MM-DD date by `n` days (UTC, pure). Used to bound the query. */
export function shiftDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map((p) => parseInt(p, 10));
  const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/** Whole-day distance between two YYYY-MM-DD dates (pure, abs). */
function daysBetween(a: string, b: string): number {
  const pa = a.split("-").map((p) => parseInt(p, 10));
  const pb = b.split("-").map((p) => parseInt(p, 10));
  const ta = Date.UTC(pa[0], (pa[1] || 1) - 1, pa[2] || 1);
  const tb = Date.UTC(pb[0], (pb[1] || 1) - 1, pb[2] || 1);
  return Math.abs(Math.round((ta - tb) / 86_400_000));
}

/**
 * Return the id of an existing transaction that the candidate would duplicate
 * (identical amount within $0.01 AND within `toleranceDays`), or null. First
 * match wins — the caller just needs ONE existing row to flag against.
 */
export function findStrictLedgerDuplicate(
  candidate: { date: string; amount: number },
  existing: readonly DedupTxRow[],
  toleranceDays: number = EMAIL_DEDUP_DATE_TOLERANCE_DAYS,
): number | null {
  const candCents = Math.round(candidate.amount * 100);
  for (const t of existing) {
    // Compare in integer cents so floating-point noise (4057.72 vs 4057.73)
    // doesn't push a genuine ±$0.01 match just over the threshold.
    if (
      Math.abs(Math.round(t.amount * 100) - candCents) <= 1 &&
      daysBetween(t.date, candidate.date) <= toleranceDays
    ) {
      return t.id;
    }
  }
  return null;
}
