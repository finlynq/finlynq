/**
 * Reconcile match engine (2026-05-23).
 *
 * Orchestrates the three matching strategies that power /api/reconcile/
 * suggestions for the standalone `/reconcile` page:
 *
 *   1. `join_existing` — pairs already in `transaction_bank_links` →
 *      surfaced as "linked" with their `link_type`. Never auto-mutated;
 *      the user explicitly unlinks via the UI.
 *
 *   2. `exact_hash` — pairs NOT yet in the join table where
 *      `transactions.import_hash = bank_transactions.import_hash` AND the
 *      account ids match. Score 1.0. Surfaced as a suggestion (manual
 *      accept required — we do not auto-link historical FK-null rows to
 *      avoid surprising the user with retroactive lineage that they may
 *      have intentionally rejected during staging review).
 *
 *   3. `fuzzy` — pairs NOT yet covered by (1) or (2), scored by a
 *      purpose-built bank↔tx scorer (small adapter of the cross-source
 *      detector's signals; we don't reuse `detectProbableDuplicates`
 *      directly because (a) its `id: number` shape doesn't fit our
 *      UUID-keyed bank rows, (b) its transfer-pair-sibling and
 *      holding-symbol soft hints don't apply here, (c) parameterizing
 *      the existing scorer on a generic id type would force every
 *      existing caller to think about a type they don't care about).
 *      The score rubric mirrors the cross-source detector for amount +
 *      date + payee so the unified threshold story (one
 *      `RECONCILE_DEFAULT_THRESHOLDS` constant) covers both surfaces.
 *
 * Greedy assignment: each bank row and each transaction is consumed at
 * most once across suggestions (one tx can't be matched to two banks via
 * fuzzy; one bank can't be matched to two txs). The user can still create
 * many-to-many links explicitly via the UI after the v1 suggestion pass —
 * the greedy strategy is only about what we recommend, not what's allowed.
 *
 * Pure-ish: this module owns the DB read for transactions and the join
 * table, and delegates the bank-side read to `buildBankLedgerCandidatePool`.
 * No writes; no MCP cache invalidations.
 */

import { and, desc, eq, gte, lte } from "drizzle-orm";
import { db, schema } from "@/db";
import { tryDecryptField } from "@/lib/crypto/envelope";
import { applyRules, type TransactionRule } from "@/lib/auto-categorize";
import type { Action, ConditionGroup } from "@/lib/rules/schema";
import {
  buildBankLedgerCandidatePool,
  type BankCandidateRow,
} from "./bank-ledger-pool";

/**
 * User-configurable thresholds for the fuzzy layer. Persisted per-user in
 * the generic `settings(key='reconcile_thresholds')` row (Phase 4); the
 * API route falls back to these defaults when no row exists.
 *
 * Values match `DEFAULT_OPTIONS` in
 * `pf-app/src/lib/external-import/duplicate-detect.ts` so the two
 * surfaces (cross-source detector at import time + reconcile page at
 * review time) stay aligned out of the box. Users can tighten via
 * `/settings/reconciliation`.
 */
export interface ReconcileThresholds {
  dateToleranceDays: number;
  amountTolerancePct: number;
  amountToleranceFloor: number;
  scoreThreshold: number;
}

export const RECONCILE_DEFAULT_THRESHOLDS: Readonly<ReconcileThresholds> = {
  dateToleranceDays: 7,
  amountTolerancePct: 0.07,
  amountToleranceFloor: 50,
  scoreThreshold: 0.6,
};

export type ReconcileStrategy = "join_existing" | "exact_hash" | "fuzzy";

export interface ReconcileLink {
  transactionId: number;
  bankTransactionId: string;
  linkType: "primary" | "extra";
  source: string;
  createdAt: string;
}

export interface ReconcileSuggestion {
  transactionId: number;
  bankTransactionId: string;
  strategy: ReconcileStrategy;
  score: number;
  reason: string;
  daysOff: number;
  amountDeltaAbs: number;
}

export interface ReconcileTxSnapshot {
  id: number;
  date: string;
  amount: number;
  currency: string;
  payee: string | null;
  categoryName: string | null;
  categoryType: string | null;
  importHash: string | null;
  accountId: number;
}

export interface ReconcileBankSnapshot {
  id: string;
  date: string;
  amount: number;
  currency: string;
  payee: string | null;
  importHash: string;
  accountId: number;
  seenCount: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  /** Rule-engine suggestion for the materialize-from-bank-row flow.
   *  `null` when no rule matches the bank row's payee/amount/etc.
   *  Populated for ALL bank rows so the UI can preview the default
   *  category before clicking Create. */
  suggestedCategoryId: number | null;
}

export interface ReconcileResult {
  linked: ReconcileLink[];
  suggestions: ReconcileSuggestion[];
  /** Bank rows with no linked transaction AND no suggestion. */
  bankOnly: string[];
  /** Transaction ids with no linked bank row AND no suggestion. */
  txOnly: number[];
  /** Per-id enrichment for the UI so it doesn't re-decrypt. */
  transactions: Record<number, ReconcileTxSnapshot>;
  bankTransactions: Record<string, ReconcileBankSnapshot>;
}

export interface ReconcileInput {
  userId: string;
  dek: Buffer | null;
  accountId: number;
  thresholds?: Partial<ReconcileThresholds>;
  /** Optional ISO YYYY-MM-DD floor on both `transactions.date` and
   *  `bank_transactions.date`. Null = no window (full history). The UI
   *  defaults to last 60 days; "All time" passes null. The match engine
   *  also auto-pads the bank-pool window by `dateToleranceDays` so an
   *  edge-of-window tx can still match a bank row just outside it. */
  dateMin?: string | null;
  /** Optional ISO YYYY-MM-DD ceiling. Null = no upper bound. The
   *  bank-pool window is symmetrically padded outward by
   *  `dateToleranceDays` so fuzzy matches near the edge still surface. */
  dateMax?: string | null;
}

/**
 * Run the three-layer match engine for one account. Returns the full
 * snapshot the API route needs to render the page.
 */
export async function computeReconcileForAccount(
  input: ReconcileInput,
): Promise<ReconcileResult> {
  const thresholds: ReconcileThresholds = {
    ...RECONCILE_DEFAULT_THRESHOLDS,
    ...(input.thresholds ?? {}),
  };
  const dateMin = input.dateMin ?? null;
  const dateMax = input.dateMax ?? null;

  const [bankPool, txRows, joinRows, activeRules] = await Promise.all([
    buildBankLedgerCandidatePool({
      userId: input.userId,
      dek: input.dek,
      accountIds: [input.accountId],
    }),
    loadTxRows(input.userId, input.accountId, input.dek, dateMin, dateMax),
    loadJoinRows(input.userId, input.accountId),
    loadActiveRulesForReconcile(input.userId),
  ]);

  // Pre-filter the bank pool to the same window. Pad symmetrically by the
  // fuzzy date tolerance so an edge-of-window tx can still match a bank
  // row just outside it via the fuzzy layer; the exact-hash + linked
  // layers only care about hash/FK so the pad has no effect there.
  const allBankRows: BankCandidateRow[] =
    bankPool.byAccount.get(input.accountId) ?? [];
  const bankDateFloor = dateMin
    ? shiftDateString(dateMin, -thresholds.dateToleranceDays)
    : null;
  const bankDateCeil = dateMax
    ? shiftDateString(dateMax, thresholds.dateToleranceDays)
    : null;
  const bankRows: BankCandidateRow[] = allBankRows.filter((b) => {
    if (bankDateFloor && b.date < bankDateFloor) return false;
    if (bankDateCeil && b.date > bankDateCeil) return false;
    return true;
  });

  // ─── Layer 1: existing links ───────────────────────────────────────
  // Track consumption so layers 2 + 3 skip pairs (and individual rows
  // on each side) that are already linked.
  const linked: ReconcileLink[] = joinRows.map((r) => ({
    transactionId: r.transactionId,
    bankTransactionId: r.bankTransactionId,
    linkType: (r.linkType === "primary" ? "primary" : "extra"),
    source: r.source,
    createdAt: r.createdAt,
  }));
  const linkedTxIds = new Set<number>();
  const linkedBankIds = new Set<string>();
  for (const l of linked) {
    linkedTxIds.add(l.transactionId);
    linkedBankIds.add(l.bankTransactionId);
  }

  // ─── Layer 2: exact-hash suggestions ───────────────────────────────
  // Index bank rows by import_hash for O(1) lookup. We surface every
  // unmatched tx whose hash matches an unmatched bank row. Greedy
  // first-come-first-served when there are duplicates (occurrence_index
  // distinguishes bank rows; transactions don't have an equivalent so
  // ties go by tx id).
  const bankByHash = new Map<string, BankCandidateRow[]>();
  for (const b of bankRows) {
    if (linkedBankIds.has(b.id)) continue;
    const arr = bankByHash.get(b.importHash) ?? [];
    arr.push(b);
    bankByHash.set(b.importHash, arr);
  }

  const suggestions: ReconcileSuggestion[] = [];
  const suggestedTxIds = new Set<number>();
  const suggestedBankIds = new Set<string>();

  for (const tx of txRows) {
    if (linkedTxIds.has(tx.id)) continue;
    if (!tx.importHash) continue;
    const bucket = bankByHash.get(tx.importHash);
    if (!bucket || bucket.length === 0) continue;
    // Pick the first unconsumed bank row in the bucket.
    let match: BankCandidateRow | null = null;
    for (const b of bucket) {
      if (!suggestedBankIds.has(b.id)) {
        match = b;
        break;
      }
    }
    if (!match) continue;
    const daysOff = daysBetween(tx.date, match.date);
    const amountDeltaAbs = Math.abs(tx.amount - match.amount);
    suggestions.push({
      transactionId: tx.id,
      bankTransactionId: match.id,
      strategy: "exact_hash",
      score: 1.0,
      reason: "import_hash match",
      daysOff,
      amountDeltaAbs,
    });
    suggestedTxIds.add(tx.id);
    suggestedBankIds.add(match.id);
  }

  // ─── Layer 3: fuzzy suggestions ────────────────────────────────────
  // Score every (unmatched tx × unmatched bank) pair using a small bank↔tx
  // scorer. Two-pass: collect scored pairs, then greedy-assign by score
  // desc with one-shot consumption.
  type ScoredPair = {
    txId: number;
    bankId: string;
    score: number;
    reason: string;
    daysOff: number;
    amountDeltaAbs: number;
  };
  const pairs: ScoredPair[] = [];

  for (const tx of txRows) {
    if (linkedTxIds.has(tx.id) || suggestedTxIds.has(tx.id)) continue;
    for (const b of bankRows) {
      if (linkedBankIds.has(b.id) || suggestedBankIds.has(b.id)) continue;
      // Skip pairs whose hash collides (already handled by Layer 2;
      // double-flagging would confuse the UI).
      if (tx.importHash && tx.importHash === b.importHash) continue;
      const scored = scoreBankToTx(tx, b, thresholds);
      if (scored) {
        pairs.push({
          txId: tx.id,
          bankId: b.id,
          score: scored.score,
          reason: scored.reason,
          daysOff: scored.daysOff,
          amountDeltaAbs: scored.amountDeltaAbs,
        });
      }
    }
  }

  pairs.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.daysOff - b.daysOff;
  });

  const fuzzyConsumedTxIds = new Set<number>();
  const fuzzyConsumedBankIds = new Set<string>();
  for (const p of pairs) {
    if (fuzzyConsumedTxIds.has(p.txId)) continue;
    if (fuzzyConsumedBankIds.has(p.bankId)) continue;
    fuzzyConsumedTxIds.add(p.txId);
    fuzzyConsumedBankIds.add(p.bankId);
    suggestions.push({
      transactionId: p.txId,
      bankTransactionId: p.bankId,
      strategy: "fuzzy",
      score: roundScore(p.score),
      reason: p.reason,
      daysOff: p.daysOff,
      amountDeltaAbs: roundDelta(p.amountDeltaAbs),
    });
    suggestedTxIds.add(p.txId);
    suggestedBankIds.add(p.bankId);
  }

  // ─── Residuals ─────────────────────────────────────────────────────
  const bankOnly: string[] = [];
  for (const b of bankRows) {
    if (linkedBankIds.has(b.id) || suggestedBankIds.has(b.id)) continue;
    bankOnly.push(b.id);
  }
  const txOnly: number[] = [];
  for (const tx of txRows) {
    if (linkedTxIds.has(tx.id) || suggestedTxIds.has(tx.id)) continue;
    txOnly.push(tx.id);
  }

  // ─── Snapshots for UI ──────────────────────────────────────────────
  const transactions: Record<number, ReconcileTxSnapshot> = {};
  for (const tx of txRows) {
    transactions[tx.id] = {
      id: tx.id,
      date: tx.date,
      amount: tx.amount,
      currency: tx.currency,
      payee: tx.payeePlain,
      categoryName: tx.categoryName,
      categoryType: tx.categoryType,
      importHash: tx.importHash,
      accountId: tx.accountId,
    };
  }
  const bankTransactions: Record<string, ReconcileBankSnapshot> = {};
  for (const b of bankRows) {
    // Compute the rule-engine suggested category for this bank row's
    // payee. `null` when no rule matches OR the matched rule has no
    // `set_category` action. The materialize dialog uses this as the
    // default value of its category select.
    const ruleMatch = applyRules(
      {
        payee: b.payeePlain,
        amount: b.amount,
        accountId: b.accountId,
        date: b.date,
      },
      activeRules,
    );
    const suggestedCategoryId = ruleMatch
      ? pickCategoryFromActions(ruleMatch.actions)
      : null;
    bankTransactions[b.id] = {
      id: b.id,
      date: b.date,
      amount: b.amount,
      currency: b.currency,
      payee: b.payeePlain,
      importHash: b.importHash,
      accountId: b.accountId,
      // Filled in below from the broader query so the UI can render
      // "seen N times" on bank-only rows.
      seenCount: 0,
      firstSeenAt: null,
      lastSeenAt: null,
      suggestedCategoryId,
    };
  }
  // Pull the per-row freshness metadata in a single follow-up query.
  // We didn't include this on the candidate pool because the scorer
  // doesn't need it; saving the join cost for the cold path.
  if (bankRows.length > 0) {
    const meta = await db
      .select({
        id: schema.bankTransactions.id,
        seenCount: schema.bankTransactions.seenCount,
        firstSeenAt: schema.bankTransactions.firstSeenAt,
        lastSeenAt: schema.bankTransactions.lastSeenAt,
      })
      .from(schema.bankTransactions)
      .where(
        and(
          eq(schema.bankTransactions.userId, input.userId),
          eq(schema.bankTransactions.accountId, input.accountId),
        ),
      )
      .all();
    for (const m of meta) {
      const snap = bankTransactions[m.id];
      if (!snap) continue;
      snap.seenCount = m.seenCount;
      snap.firstSeenAt = m.firstSeenAt?.toISOString() ?? null;
      snap.lastSeenAt = m.lastSeenAt?.toISOString() ?? null;
    }
  }

  return {
    linked,
    suggestions,
    bankOnly,
    txOnly,
    transactions,
    bankTransactions,
  };
}

// ─── Internal helpers ────────────────────────────────────────────────

interface TxLoaded {
  id: number;
  accountId: number;
  date: string;
  amount: number;
  currency: string;
  payeePlain: string | null;
  categoryName: string | null;
  categoryType: string | null;
  importHash: string | null;
}

/**
 * Shift a YYYY-MM-DD string by N days. Used to pad the bank-pool window
 * by the fuzzy date tolerance.
 */
function shiftDateString(iso: string, deltaDays: number): string {
  const ms = Date.parse(iso + "T00:00:00Z");
  if (Number.isNaN(ms)) return iso;
  const d = new Date(ms + deltaDays * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/**
 * Pick the first `set_category` action's categoryId from a rule's
 * action list, if any. Returns null when none of the actions is a
 * `set_category`. Rules-v2 allows multiple actions per rule but only
 * one category-setting action is meaningful (later ones overwrite); we
 * mirror the patcher's first-wins semantics.
 */
function pickCategoryFromActions(actions: Action[]): number | null {
  for (const a of actions) {
    if (a.kind === "set_category" && typeof a.categoryId === "number") {
      return a.categoryId;
    }
  }
  return null;
}

/**
 * Load the user's active transaction rules in priority-descending order,
 * shaped for `applyRules()`. Read-only — no DEK needed because
 * `transaction_rules.conditions` + `actions` are JSONB (not encrypted).
 */
async function loadActiveRulesForReconcile(
  userId: string,
): Promise<TransactionRule[]> {
  const rows = await db
    .select({
      id: schema.transactionRules.id,
      name: schema.transactionRules.name,
      conditions: schema.transactionRules.conditions,
      actions: schema.transactionRules.actions,
      isActive: schema.transactionRules.isActive,
      priority: schema.transactionRules.priority,
    })
    .from(schema.transactionRules)
    .where(
      and(
        eq(schema.transactionRules.userId, userId),
        eq(schema.transactionRules.isActive, true),
      ),
    )
    .orderBy(desc(schema.transactionRules.priority), schema.transactionRules.id)
    .all();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    conditions: (r.conditions ?? { all: [] }) as ConditionGroup,
    actions: (Array.isArray(r.actions) ? r.actions : []) as Action[],
    isActive: r.isActive,
    priority: r.priority ?? 0,
  }));
}

async function loadTxRows(
  userId: string,
  accountId: number,
  dek: Buffer | null,
  dateMin: string | null,
  dateMax: string | null,
): Promise<TxLoaded[]> {
  const whereClauses = [
    eq(schema.transactions.userId, userId),
    eq(schema.transactions.accountId, accountId),
  ];
  if (dateMin) {
    whereClauses.push(gte(schema.transactions.date, dateMin));
  }
  if (dateMax) {
    whereClauses.push(lte(schema.transactions.date, dateMax));
  }
  const rows = await db
    .select({
      id: schema.transactions.id,
      accountId: schema.transactions.accountId,
      date: schema.transactions.date,
      amount: schema.transactions.amount,
      currency: schema.transactions.currency,
      payee: schema.transactions.payee,
      importHash: schema.transactions.importHash,
      categoryNameCt: schema.categories.nameCt,
      categoryType: schema.categories.type,
    })
    .from(schema.transactions)
    .leftJoin(
      schema.categories,
      eq(schema.transactions.categoryId, schema.categories.id),
    )
    .where(and(...whereClauses))
    .all();

  return rows.flatMap((r) => {
    if (r.accountId == null) return [];
    return [{
      id: r.id,
      accountId: r.accountId,
      date: r.date,
      amount: r.amount,
      currency: r.currency,
      payeePlain: decryptTxPayee(dek, r.payee),
      categoryName:
        r.categoryNameCt && dek
          ? tryDecryptField(dek, r.categoryNameCt, "categories.name_ct")
          : null,
      categoryType: r.categoryType,
      importHash: r.importHash,
    }];
  });
}

interface JoinLoaded {
  transactionId: number;
  bankTransactionId: string;
  linkType: string;
  source: string;
  createdAt: string;
}

async function loadJoinRows(
  userId: string,
  accountId: number,
): Promise<JoinLoaded[]> {
  // We only want join rows for tx+bank in this account. Filter by joining
  // through transactions.account_id (the canonical scope). Bank rows in
  // other accounts are out of scope for the per-account view.
  const rows = await db
    .select({
      transactionId: schema.transactionBankLinks.transactionId,
      bankTransactionId: schema.transactionBankLinks.bankTransactionId,
      linkType: schema.transactionBankLinks.linkType,
      source: schema.transactionBankLinks.source,
      createdAt: schema.transactionBankLinks.createdAt,
      txAccountId: schema.transactions.accountId,
    })
    .from(schema.transactionBankLinks)
    .innerJoin(
      schema.transactions,
      eq(
        schema.transactions.id,
        schema.transactionBankLinks.transactionId,
      ),
    )
    .where(
      and(
        eq(schema.transactionBankLinks.userId, userId),
        eq(schema.transactions.accountId, accountId),
      ),
    )
    .all();

  return rows.map((r) => ({
    transactionId: r.transactionId,
    bankTransactionId: r.bankTransactionId,
    linkType: r.linkType,
    source: r.source,
    createdAt: r.createdAt.toISOString(),
  }));
}

function decryptTxPayee(
  dek: Buffer | null,
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  if (!value.startsWith("v1:")) return value;
  if (!dek) return null;
  return tryDecryptField(dek, value, "transactions.payee");
}

interface ScoreOutput {
  score: number;
  reason: string;
  daysOff: number;
  amountDeltaAbs: number;
  amountDeltaPct: number;
}

/**
 * Score a (tx, bank) pair for the fuzzy layer. Returns null when the pair
 * fails a hard gate (sign mismatch, amount out of window, date out of
 * window) or scores below threshold.
 *
 * Rubric mirrors the cross-source detector's amount+date+payee signals so
 * thresholds tuned for one surface translate to the other. The detector's
 * holding-symbol and transfer-pair-sibling soft hints are intentionally
 * omitted — bank_transactions doesn't carry that info and synthesizing
 * it from the tx side alone would bias scores in surprising ways.
 */
function scoreBankToTx(
  tx: TxLoaded,
  bank: BankCandidateRow,
  thresholds: ReconcileThresholds,
): ScoreOutput | null {
  // Hard: same direction. Banks never flip signs vs. user-side.
  if (Math.sign(tx.amount) !== Math.sign(bank.amount)) return null;

  const amountDeltaAbs = Math.abs(tx.amount - bank.amount);
  const denom = Math.max(Math.abs(tx.amount), Math.abs(bank.amount), 0.01);
  const amountDeltaPct = amountDeltaAbs / denom;
  const amountWindow = Math.max(
    Math.abs(tx.amount) * thresholds.amountTolerancePct,
    thresholds.amountToleranceFloor,
  );
  if (amountDeltaAbs > amountWindow) return null;

  const daysOff = daysBetween(tx.date, bank.date);
  if (daysOff > thresholds.dateToleranceDays) return null;

  // Base = required hits.
  let score = 0.4 + 0.3;
  const reasonParts: string[] = [];
  reasonParts.push(
    thresholds.amountTolerancePct > 0
      ? `amount within ±${Math.round(thresholds.amountTolerancePct * 100)}% / ±${thresholds.amountToleranceFloor}`
      : "exact amount",
  );
  reasonParts.push(`±${daysOff}d`);

  // Soft: payee token-set Jaccard.
  const sim = payeeSimilarity(tx.payeePlain, bank.payeePlain);
  if (sim >= 0.5) {
    score += 0.1;
    reasonParts.push("payee match");
  }

  if (score < thresholds.scoreThreshold) return null;
  return {
    score,
    reason: reasonParts.join(", "),
    daysOff,
    amountDeltaAbs,
    amountDeltaPct,
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
  return Math.round(d * 10000) / 10000;
}
