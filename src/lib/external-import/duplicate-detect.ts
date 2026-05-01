/**
 * Cross-source duplicate detector (issue #65).
 *
 * Pure heuristic that flags rows in an import preview as probable duplicates
 * of an existing transaction even when the strict (date, account, amount,
 * payee) hash misses — typical case is the same real-world transfer booked
 * from two perspectives (bank statement + brokerage statement) where FX
 * spread and settlement-vs-posting timing make the hashes differ.
 *
 * No DB side effects. Caller (orchestrator / preview route / reconcile)
 * pre-fetches a candidate pool via {@link buildDuplicateCandidatePool} and
 * passes it in. This keeps the helper unit-testable and stops it from
 * exploding into N queries during a 1k-row CSV.
 *
 * The reconcile flow shipped in PR #52 had its own per-account, exact-amount,
 * ±3-days matcher — that block now delegates here with `{ amountTolerancePct:
 * 0, amountToleranceFloor: 0.005, dateToleranceDays: 3, scoreThreshold: 0.5 }`
 * so reconcile semantics are unchanged. Regular `/import/preview` calls with
 * the looser FX-spread-aware defaults below.
 *
 * Scoring rubric (heuristic, not ML):
 * - **Hard requirements** (else not a candidate): same `accountId`, same sign
 *   of amount, candidate's `importHash` ≠ row's `importHash` (exact-match is
 *   handled upstream — double-flagging would confuse the UI).
 * - **+0.4** amount within `±7%` OR `±$50` (whichever larger). Required.
 *   Pct chosen to catch FX-spread + timing drift on the Session 2 IBKR
 *   transfer scenarios (worst case: $307 spread on a $5,000 USD deposit
 *   ≈ 6.14%). Bumped from 5% to give a small buffer; reconcile path
 *   overrides this to 0% for exact-cent matching.
 * - **+0.3** date within `±7 days`. Required.
 * - **+0.1** payee similarity — token-set Jaccard ≥ 0.5 on
 *   `lower().trim().split(/[^a-z0-9]+/)`. Soft.
 * - **+0.1** same `portfolioHoldingId` (or canonicalized symbol via
 *   `holdingSymbolByHoldingId`). Soft.
 * - **+0.1** transfer-pair sibling boost: candidate has `categoryType='R'`
 *   (transfer-leg) AND `linkId` populated AND the sibling leg's accountId
 *   equals the new row's accountId. This is the bank-to-brokerage
 *   cross-account hint.
 * - Threshold: `score >= 0.6` flags. Highest score wins; each candidate is
 *   consumed at most once across all input rows so two new rows can't both
 *   collide with the same existing transaction.
 *
 * **Load-bearing invariants** (CLAUDE.md):
 * - The pool query MUST decrypt `payee_ct` with `?? plaintext` fallback.
 *   `tryDecryptField` returns `null` on auth-tag failure — never the raw
 *   ciphertext. The caller honors this in {@link buildDuplicateCandidatePool}.
 * - The detector reads, never writes. No `invalidateUser(userId)` calls.
 * - `import_hash` is over plaintext payee — non-deterministic on ciphertext
 *   so we use `tx.id` as the consume-key instead of (date,amount,payee).
 * - The pool query intentionally does NOT filter on `accounts.archived`;
 *   archived accounts can still contain transactions that should match. If
 *   a future refactor joins through `accounts`, add the
 *   `getAccounts(userId, { includeArchived: true })`-equivalent filter.
 */

export interface DuplicateCandidatePool {
  /**
   * Pool of recent transactions, indexed by `accountId`. The caller pre-fetches
   * once per import (one DB round trip) over the union of the import's
   * account ids and a `min(date) - 7d .. max(date) + 7d` window so this
   * helper can stay synchronous + unit-testable.
   */
  byAccount: Map<number, DuplicateCandidateRow[]>;
  /**
   * Optional: holding id → canonical symbol. Used for the soft +0.1 boost
   * when the new row's `portfolioHolding` symbol matches an existing
   * candidate's holding symbol (caught even if the FK ids differ across
   * accounts).
   */
  holdingSymbolByHoldingId?: Map<number, string>;
  /**
   * Optional: linkId → sibling-leg accountId. For a transfer-pair candidate
   * (`categoryType='R'` and a populated `linkId`), this maps to the OTHER
   * leg's account so we can boost score when the new row lands on the
   * sibling.
   */
  siblingAccountByLinkId?: Map<string, number>;
}

export interface DuplicateCandidateRow {
  id: number;
  accountId: number;
  date: string;          // ISO YYYY-MM-DD
  amount: number;        // account-currency, signed
  /** Plaintext (post-decrypt) payee. `null` if both ct and plaintext fall back. */
  payeePlain: string | null;
  importHash: string | null;
  fitId: string | null;
  linkId: string | null;
  /**
   * Category type joined from `categories.type`: 'I' income, 'E' expense,
   * 'R' reconciliation/transfer. May be null if the transaction is
   * uncategorized. Used for the transfer-pair sibling hint.
   */
  categoryType: string | null;
  source: string | null;
  portfolioHoldingId: number | null;
}

export interface DuplicateDetectInput {
  rowIndex: number;
  date: string;          // ISO YYYY-MM-DD
  accountId: number;
  amount: number;        // account-currency, signed
  payeePlain: string;
  importHash?: string | null;
  portfolioHoldingId?: number | null;
  /** Optional canonical symbol for the row's holding — used for cross-account hint. */
  holdingSymbol?: string | null;
}

export interface DuplicateMatch {
  rowIndex: number;
  matchedTransactionId: number;
  matchScore: number;          // 0..1
  matchReason: string;          // human-readable
  matchedTx: {
    id: number;
    date: string;
    amount: number;
    source: string | null;
    daysOff: number;
    amountDeltaPct: number;
    amountDeltaAbs: number;
  };
}

export interface DuplicateDetectOptions {
  /** Default 7. */
  dateToleranceDays?: number;
  /** Default 0.07 (= 7%). */
  amountTolerancePct?: number;
  /** Default 50.00 — absolute floor in account currency. */
  amountToleranceFloor?: number;
  /** Default 0.6. */
  scoreThreshold?: number;
}

const DEFAULT_OPTIONS: Required<DuplicateDetectOptions> = {
  dateToleranceDays: 7,
  amountTolerancePct: 0.07,
  amountToleranceFloor: 50,
  scoreThreshold: 0.6,
};

/**
 * Detect probable duplicates for a batch of input rows against an existing
 * transaction pool. Pure function — no DB calls, no side effects.
 *
 * Each existing transaction can only be flagged once across all input rows.
 * If two new rows compete for the same candidate, the higher-scoring row
 * keeps the match and the lower-scoring row is left unflagged.
 */
export function detectProbableDuplicates(
  rows: DuplicateDetectInput[],
  pool: DuplicateCandidatePool,
  opts: DuplicateDetectOptions = {},
): DuplicateMatch[] {
  const o = { ...DEFAULT_OPTIONS, ...opts };
  // Two-pass: score every (row, candidate) pair, then assign greedily by
  // descending score with one-shot consumption. Keeps the result stable
  // regardless of input order for ties.
  type ScoredPair = {
    rowIndex: number;
    candidateId: number;
    score: number;
    reason: string;
    daysOff: number;
    amountDeltaPct: number;
    amountDeltaAbs: number;
    candidate: DuplicateCandidateRow;
  };
  const pairs: ScoredPair[] = [];

  for (const row of rows) {
    const candidates = pool.byAccount.get(row.accountId) ?? [];
    for (const cand of candidates) {
      const scored = scorePair(row, cand, pool, o);
      if (scored) {
        pairs.push({
          rowIndex: row.rowIndex,
          candidateId: cand.id,
          ...scored,
          candidate: cand,
        });
      }
    }
  }

  // Greedy assignment by score desc — break ties by smaller daysOff so the
  // closer date wins.
  pairs.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.daysOff - b.daysOff;
  });

  const consumedCandidates = new Set<number>();
  const consumedRows = new Set<number>();
  const matches: DuplicateMatch[] = [];

  for (const p of pairs) {
    if (consumedRows.has(p.rowIndex)) continue;
    if (consumedCandidates.has(p.candidateId)) continue;
    consumedRows.add(p.rowIndex);
    consumedCandidates.add(p.candidateId);
    matches.push({
      rowIndex: p.rowIndex,
      matchedTransactionId: p.candidateId,
      matchScore: roundScore(p.score),
      matchReason: p.reason,
      matchedTx: {
        id: p.candidate.id,
        date: p.candidate.date,
        amount: p.candidate.amount,
        source: p.candidate.source,
        daysOff: p.daysOff,
        amountDeltaPct: roundDelta(p.amountDeltaPct),
        amountDeltaAbs: roundDelta(p.amountDeltaAbs),
      },
    });
  }

  // Stable order for the API response: by rowIndex.
  matches.sort((a, b) => a.rowIndex - b.rowIndex);
  return matches;
}

interface ScoreOutput {
  score: number;
  reason: string;
  daysOff: number;
  amountDeltaPct: number;
  amountDeltaAbs: number;
}

function scorePair(
  row: DuplicateDetectInput,
  cand: DuplicateCandidateRow,
  pool: DuplicateCandidatePool,
  o: Required<DuplicateDetectOptions>,
): ScoreOutput | null {
  // Hard: same account
  if (cand.accountId !== row.accountId) {
    // The cross-account transfer-pair hint (handled below) requires the
    // candidate to be in a DIFFERENT account but indexed under the row's
    // account via siblingAccountByLinkId. The pool already pre-filters by
    // row.accountId; sibling rows are added under that key by the pool
    // builder so we never reach this branch for the cross-account case.
    return null;
  }
  // Hard: same direction
  if (Math.sign(row.amount) !== Math.sign(cand.amount)) return null;
  // Hard: skip exact-hash candidates (handled upstream — UI would double-flag)
  if (
    row.importHash &&
    cand.importHash &&
    row.importHash === cand.importHash
  ) {
    return null;
  }

  const amountDeltaAbs = Math.abs(row.amount - cand.amount);
  const denom = Math.max(Math.abs(row.amount), Math.abs(cand.amount), 0.01);
  const amountDeltaPct = amountDeltaAbs / denom;
  // Amount tolerance: pass if within pct OR within absolute floor (whichever
  // larger). For reconcile (pct=0, floor=0.005) this collapses to "within
  // half a cent" → exact-amount-cents.
  const amountWindow = Math.max(
    Math.abs(row.amount) * o.amountTolerancePct,
    o.amountToleranceFloor,
  );
  if (amountDeltaAbs > amountWindow) return null;

  const daysOff = daysBetween(row.date, cand.date);
  if (daysOff > o.dateToleranceDays) return null;

  // Required: amount-window + date-window. Base score = 0.7.
  let score = 0.4 + 0.3;
  const reasonParts: string[] = [];
  if (amountWindow > 0 && o.amountTolerancePct > 0) {
    reasonParts.push(
      `amount within ${formatTolerance(o.amountTolerancePct, o.amountToleranceFloor)}`,
    );
  } else {
    reasonParts.push("exact amount");
  }
  reasonParts.push(`±${daysOff}d`);

  // Soft: payee similarity (Jaccard on token sets).
  const sim = payeeSimilarity(row.payeePlain, cand.payeePlain);
  if (sim >= 0.5) {
    score += 0.1;
    reasonParts.push("payee match");
  }

  // Soft: same holding (FK or canonical symbol).
  let holdingMatch = false;
  if (
    row.portfolioHoldingId != null &&
    cand.portfolioHoldingId != null &&
    row.portfolioHoldingId === cand.portfolioHoldingId
  ) {
    holdingMatch = true;
  } else if (
    pool.holdingSymbolByHoldingId &&
    row.holdingSymbol &&
    cand.portfolioHoldingId != null
  ) {
    const candSym = pool.holdingSymbolByHoldingId.get(cand.portfolioHoldingId);
    if (candSym && candSym.toUpperCase() === row.holdingSymbol.toUpperCase()) {
      holdingMatch = true;
    }
  }
  if (holdingMatch) {
    score += 0.1;
    reasonParts.push("same holding");
  }

  // Soft: transfer-pair sibling boost.
  // The candidate is a transfer leg with a sibling (other leg). If the
  // sibling's accountId matches the new row's accountId, the new row is
  // landing right on top of the sibling — strong hint that the user is
  // re-importing the same real-world transfer from the other side.
  if (
    cand.categoryType === "R" &&
    cand.linkId &&
    pool.siblingAccountByLinkId
  ) {
    const siblingAccountId = pool.siblingAccountByLinkId.get(cand.linkId);
    if (siblingAccountId != null && siblingAccountId === row.accountId) {
      score += 0.1;
      reasonParts.push("transfer-pair sibling");
    }
  }

  if (score < o.scoreThreshold) return null;

  return {
    score,
    reason: reasonParts.join(", "),
    daysOff,
    amountDeltaPct,
    amountDeltaAbs,
  };
}

function daysBetween(a: string, b: string): number {
  const ams = Date.parse(a + "T00:00:00Z");
  const bms = Date.parse(b + "T00:00:00Z");
  if (Number.isNaN(ams) || Number.isNaN(bms)) return Number.POSITIVE_INFINITY;
  return Math.round(Math.abs(ams - bms) / 86_400_000);
}

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 0),
  );
}

function payeeSimilarity(a: string | null, b: string | null): number {
  if (!a || !b) return 0;
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersect = 0;
  for (const t of ta) if (tb.has(t)) intersect++;
  const union = ta.size + tb.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

function roundScore(s: number): number {
  return Math.round(s * 100) / 100;
}

function roundDelta(d: number): number {
  // Two decimals for currency, four for ratios. Caller distinguishes by field.
  return Math.round(d * 10000) / 10000;
}

function formatTolerance(pct: number, floor: number): string {
  return `±${Math.round(pct * 100)}% / ±${floor}`;
}
