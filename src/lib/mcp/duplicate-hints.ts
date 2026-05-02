// Issue #90 — bulk_record_transactions post-insert duplicate-hint scan.
//
// After bulk_record_transactions commits a batch, we run ONE indexed query
// per affected account to fetch existing rows in the union of [minDate-7d,
// maxDate+7d] for every newly-inserted row, then filter in-memory for
// near-matches. The hint is HINTS-ONLY — never blocks the insert. The
// caller decides whether to delete a leg.
//
// Match criteria, per inserted row:
//   - same account_id
//   - same direction (sign(new.amount) === sign(existing.amount));
//     rows with new.amount === 0 are skipped (direction undefined,
//     false-positive risk too high — RSU vests, in-kind transfers).
//   - |new.amount - existing.amount| / max(|new.amount|, |existing.amount|)
//     <= 0.05 (5% absolute amount delta tolerance).
//   - |new.date - existing.date| <= 7 days.
//   - existing.id !== new.id (don't self-match).
//
// Score = 1 - (deltaAmount/maxAmount * 0.5 + deltaDays/7 * 0.5). Anything
// >= 0 surfaces.
//
// IMPORTANT: callers must pass already-decrypted (plaintext) payees in the
// candidate pool. HTTP MCP decrypts via tryDecryptField with the standard
// `?? plaintext` fallback (see CLAUDE.md "tryDecryptField MUST return null
// on auth-tag failure"); stdio MCP writes are plaintext so no decrypt
// happens. Never hash-compare ciphertexts (AES-GCM IVs are random — every
// ciphertext differs).

export type CommittedInsert = {
  newTransactionId: number;
  accountId: number;
  date: string; // YYYY-MM-DD
  amount: number;
  payee: string;
};

export type CandidateRow = {
  id: number;
  accountId: number;
  date: string; // YYYY-MM-DD
  amount: number;
  payee: string;
};

export type PossibleDup = {
  newTransactionId: number;
  newDate: string;
  newAmount: number;
  matchTransactionId: number;
  matchDate: string;
  matchAmount: number;
  matchPayee: string;
  deltaAmount: number;
  deltaDays: number;
  score: number;
  note: string;
};

const AMOUNT_TOLERANCE = 0.05; // 5%
const MAX_DATE_DELTA_DAYS = 7;

/** Days between two YYYY-MM-DD date strings, parsed as UTC midnight. */
function daysBetween(a: string, b: string): number {
  const ta = Date.parse(a + "T00:00:00Z");
  const tb = Date.parse(b + "T00:00:00Z");
  if (Number.isNaN(ta) || Number.isNaN(tb)) return Number.POSITIVE_INFINITY;
  const ms = Math.abs(ta - tb);
  return Math.round(ms / (24 * 60 * 60 * 1000));
}

/**
 * Scan committed inserts against a candidate pool, return only the entries
 * that meet the match criteria. The candidate pool should already be
 * filtered to the union of affected accounts and date windows + exclude the
 * newly-inserted ids — this function does the per-row band check + scoring.
 */
export function scanForPossibleDuplicates(
  committed: CommittedInsert[],
  candidates: CandidateRow[],
): PossibleDup[] {
  if (committed.length === 0 || candidates.length === 0) return [];

  // Group candidates by account_id so the inner loop is cheap.
  const byAccount = new Map<number, CandidateRow[]>();
  for (const c of candidates) {
    let bucket = byAccount.get(c.accountId);
    if (!bucket) {
      bucket = [];
      byAccount.set(c.accountId, bucket);
    }
    bucket.push(c);
  }

  const out: PossibleDup[] = [];
  for (const ins of committed) {
    // Direction undefined for zero-amount rows (RSU vests, in-kind moves).
    if (ins.amount === 0) continue;
    const insSign = Math.sign(ins.amount);
    const insAbs = Math.abs(ins.amount);
    const bucket = byAccount.get(ins.accountId);
    if (!bucket) continue;
    for (const cand of bucket) {
      if (cand.id === ins.newTransactionId) continue;
      if (cand.amount === 0) continue;
      if (Math.sign(cand.amount) !== insSign) continue;

      const candAbs = Math.abs(cand.amount);
      const maxAbs = Math.max(insAbs, candAbs);
      const deltaAmount = Math.abs(ins.amount - cand.amount);
      if (maxAbs === 0) continue;
      const ratio = deltaAmount / maxAbs;
      if (ratio > AMOUNT_TOLERANCE) continue;

      const deltaDays = daysBetween(ins.date, cand.date);
      if (deltaDays > MAX_DATE_DELTA_DAYS) continue;

      const score = 1 - (ratio / AMOUNT_TOLERANCE) * 0.5 - (deltaDays / MAX_DATE_DELTA_DAYS) * 0.5;
      // ratio is in [0, 0.05], deltaDays in [0, 7] — score is in [0, 1].
      const pctText = (ratio * 100).toFixed(1);
      const note = `Same account, same direction, amounts within ${pctText}%, dates ${deltaDays} day${deltaDays === 1 ? "" : "s"} apart`;
      out.push({
        newTransactionId: ins.newTransactionId,
        newDate: ins.date,
        newAmount: ins.amount,
        matchTransactionId: cand.id,
        matchDate: cand.date,
        matchAmount: cand.amount,
        matchPayee: cand.payee,
        deltaAmount: round2(deltaAmount),
        deltaDays,
        score: round3(score),
        note,
      });
    }
  }
  return out;
}

/**
 * Compute the global date window for a SQL bound across every committed
 * insert: [minDate - 7d, maxDate + 7d]. Returns inclusive bounds as
 * YYYY-MM-DD strings. Used by callers to bind a single SELECT covering
 * every affected account's pool. Returns null when committed is empty.
 */
export function dateBoundsForScan(
  committed: CommittedInsert[],
): { minDate: string; maxDate: string } | null {
  if (committed.length === 0) return null;
  let min = committed[0].date;
  let max = committed[0].date;
  for (let i = 1; i < committed.length; i++) {
    if (committed[i].date < min) min = committed[i].date;
    if (committed[i].date > max) max = committed[i].date;
  }
  return {
    minDate: shiftDays(min, -MAX_DATE_DELTA_DAYS),
    maxDate: shiftDays(max, MAX_DATE_DELTA_DAYS),
  };
}

function shiftDays(date: string, days: number): string {
  const t = Date.parse(date + "T00:00:00Z");
  if (Number.isNaN(t)) return date;
  const shifted = new Date(t + days * 24 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
