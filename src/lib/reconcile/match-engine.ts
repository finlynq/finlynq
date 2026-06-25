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

import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { db, schema } from "@/db";
import { round2 } from "@/lib/utils/number";
import { encryptField, tryDecryptField } from "@/lib/crypto/envelope";
import { decryptStaged } from "@/lib/crypto/staging-envelope";
import { applyRules, type TransactionRule } from "@/lib/auto-categorize";
import { computePureActionPatch } from "@/lib/rules/execute";
import { decryptRuleFields } from "@/lib/rules/crypto";
import type { Action, ConditionGroup, RecordInvestmentOpAction } from "@/lib/rules/schema";
import { invalidateUser } from "@/lib/mcp/user-tx-cache";
import { validateSignVsCategoryById } from "@/lib/transactions/sign-category-invariant";
import { materializeBankRowAsTransfer } from "./materialize-transfer";
import { materializeBankRowAsPortfolioOp } from "./materialize-portfolio-op";
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
  /** Transfer-pair / portfolio-pair lineage. Surfaced so the
   *  /reconcile click-to-highlight UX can fan out across pair siblings
   *  client-side without an extra round-trip per click. Plan #5 (2026-05-25). */
  linkId: string | null;
  tradeLinkId: string | null;
  swapLinkId: string | null;
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
  /** Rule-engine transfer suggestion: the destination account id from a
   *  matched rule's `create_transfer` action, when one applies and it's not
   *  a self-transfer. `null` otherwise. Drives the materialize dialog into
   *  Transfer mode with the destination pre-filled (the dialog still commits
   *  through `createTransferPair`, so the four-check link_id invariant holds). */
  suggestedTransferAccountId: number | null;
  /** Possible-duplicate detection (2026-06-04). The id of an existing
   *  UNLINKED ledger transaction this bank row STRICTLY matches — exact
   *  `import_hash`, OR identical amount (±$0.01) within `dateToleranceDays`.
   *  `null` when no strict match. Distinct from `suggestions` (the loose,
   *  ±$50-floor, greedily-assigned reconcile fuzzy layer): a tight,
   *  per-row-independent signal used to flag duplicates in Auto-pilot /
   *  Approve-each (where bank-side dedup can't see the ledger). */
  duplicateOfTransactionId: number | null;
  /** Investment-import capture (FINLYNQ-195 store / FINLYNQ-207 surface).
   *  Plaintext TICKER/symbol after per-`encryption_tier` decrypt. Present
   *  ONLY on rows that actually captured an investment field (an investment
   *  account import); OMITTED entirely for cash rows so the cash reconcile
   *  view + API shape stay byte-identical. `null` here means "captured but
   *  undecryptable" (no DEK / auth-tag failure) — never raw ciphertext. */
  ticker?: string | null;
  /** Plaintext security NAME, same per-tier decrypt + same present-only-when-
   *  captured rule as `ticker`. */
  securityName?: string | null;
  /** Share/unit count for an investment row. Numeric, never encrypted.
   *  Present only when captured; omitted for cash rows. */
  quantity?: number | null;
  /** FINLYNQ-208 — when a user-authored rule's action is `record_investment_op`,
   *  the op type it would record (buy/sell/dividend/interest/fee/deposit/
   *  withdrawal). Lets the reconcile UI preview "this row → Buy" before the user
   *  applies the rule. `null`/absent when no investment-op rule matches. */
  suggestedInvestmentOp?: string | null;
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
    loadActiveRulesForReconcile(input.userId, input.dek),
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
      linkId: tx.linkId,
      tradeLinkId: tx.tradeLinkId,
      swapLinkId: tx.swapLinkId,
    };
  }
  // ─── Strict possible-duplicate index (2026-06-04) ──────────────────────
  // For flagging duplicates against the LEDGER (Auto-pilot / Approve-each).
  // Independent of the loose `suggestions` layer: exact import_hash OR
  // identical amount (±$0.01) within dateToleranceDays. Per-row, no greedy
  // consumption (two import rows can each flag the same tx — the user resolves
  // each; linking one re-pairs on the next read).
  const unlinkedTxList = txRows.filter((t) => !linkedTxIds.has(t.id));
  const unlinkedTxByHash = new Map<string, number>();
  for (const t of unlinkedTxList) {
    if (t.importHash && !unlinkedTxByHash.has(t.importHash)) {
      unlinkedTxByHash.set(t.importHash, t.id);
    }
  }
  const strictDupFor = (b: BankCandidateRow): number | null => {
    if (linkedBankIds.has(b.id)) return null;
    if (b.importHash) {
      const hit = unlinkedTxByHash.get(b.importHash);
      if (hit != null) return hit;
    }
    for (const t of unlinkedTxList) {
      if (
        Math.abs(t.amount - b.amount) <= 0.01 &&
        Math.abs(daysBetween(t.date, b.date)) <= thresholds.dateToleranceDays
      ) {
        return t.id;
      }
    }
    return null;
  };

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
        // FINLYNQ-208 — investment-import captured fields so a rule's
        // ticker/security_name/quantity conditions can match here too.
        ticker: b.tickerPlain,
        securityName: b.securityNamePlain,
        quantity: b.quantity,
      },
      activeRules,
    );
    const suggestedCategoryId = ruleMatch
      ? pickCategoryFromActions(ruleMatch.actions)
      : null;
    // All investment-op names the matched rule would record (e.g. "buy, deposit"
    // for a multi-op rule) so the UI chip + preview reflect every op, not just
    // the first.
    const invOpNames = ruleMatch
      ? ruleMatch.actions
          .filter((a): a is RecordInvestmentOpAction => a.kind === "record_investment_op")
          .map((a) => (a.settleAs === "shares" ? `${a.op} (shares)` : a.op))
      : [];
    const suggestedInvestmentOp = invOpNames.length > 0 ? invOpNames.join(", ") : null;
    // A matched rule whose action set names a transfer destination routes
    // the materialize dialog into Transfer mode. Drop self-transfers (a rule
    // pointing back at the bank row's own account is a no-op pair).
    const transferDest = ruleMatch
      ? pickTransferDestFromActions(ruleMatch.actions)
      : null;
    const suggestedTransferAccountId =
      transferDest != null && transferDest !== b.accountId ? transferDest : null;
    const snap: ReconcileBankSnapshot = {
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
      suggestedTransferAccountId,
      duplicateOfTransactionId: strictDupFor(b),
    };
    if (suggestedInvestmentOp) snap.suggestedInvestmentOp = suggestedInvestmentOp;
    // FINLYNQ-207 — surface the FINLYNQ-195 investment-import capture. Attach
    // ticker/securityName/quantity ONLY when the row actually captured one (an
    // investment-account import); cash rows leave all three NULL so the keys
    // stay OFF the snapshot and the cash reconcile view + API shape are
    // byte-identical to today. The plaintext is already per-tier-decrypted in
    // the candidate pool (null on no-DEK / auth-tag failure — never ciphertext).
    if (
      b.tickerPlain != null ||
      b.securityNamePlain != null ||
      b.quantity != null
    ) {
      snap.ticker = b.tickerPlain;
      snap.securityName = b.securityNamePlain;
      snap.quantity = b.quantity;
    }
    bankTransactions[b.id] = snap;
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
  linkId: string | null;
  tradeLinkId: string | null;
  swapLinkId: string | null;
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
 * Pick the first `create_transfer` action's destination account id from a
 * rule's action list, if any. Returns null when none of the actions is a
 * `create_transfer`. Mirrors `pickCategoryFromActions`' first-wins semantics.
 *
 * Unlike the staging-approve path (which mints the transfer pair's `link_id`
 * at approve time), this only SUGGESTS a destination so the reconcile
 * materialize dialog can open in Transfer mode pre-filled; the actual pair is
 * still written by the dialog through `createTransferPair`, preserving the
 * four-check link_id invariant.
 */
function pickTransferDestFromActions(actions: Action[]): number | null {
  for (const a of actions) {
    if (a.kind === "create_transfer" && typeof a.destAccountId === "number") {
      return a.destAccountId;
    }
  }
  return null;
}


/**
 * Load the user's active transaction rules in priority-descending order,
 * shaped for `applyRules()`.
 *
 * 2026-06-01 — rule sensitive free-text (name + payee/note/tags condition
 * values + rename_payee.to + set_tags.tags) is now user-DEK encrypted at rest.
 * The DEK is REQUIRED to match: each rule is decrypted before it reaches the
 * pure matcher. A null DEK leaves the values as ciphertext, which won't
 * substring-match any plaintext payee — "no DEK ⇒ no match" rather than a
 * crash, and the materialize dialog simply shows no suggested category.
 * FK ids inside actions stay plaintext, so the matcher dispatch is unaffected.
 */
async function loadActiveRulesForReconcile(
  userId: string,
  dek: Buffer | null,
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
  return rows.map((r) => {
    const dec = decryptRuleFields(dek, {
      name: r.name,
      conditions: (r.conditions ?? { all: [] }) as ConditionGroup,
      actions: (Array.isArray(r.actions) ? r.actions : []) as Action[],
    });
    return {
      id: r.id,
      name: dec.name ?? r.name,
      conditions: (dec.conditions ?? { all: [] }) as ConditionGroup,
      actions: (dec.actions ?? []) as Action[],
      isActive: r.isActive,
      priority: r.priority ?? 0,
    };
  });
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
      linkId: schema.transactions.linkId,
      tradeLinkId: schema.transactions.tradeLinkId,
      swapLinkId: schema.transactions.swapLinkId,
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
      linkId: r.linkId,
      tradeLinkId: r.tradeLinkId,
      swapLinkId: r.swapLinkId,
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
  // We only want join rows for tx+bank in THIS account. Both sides must be
  // scoped: the transaction's account AND the bank row's account must equal
  // `accountId`. Filtering on the tx side alone (the pre-FINLYNQ-211 bug) let
  // a transfer leg in account A that was linked to a bank row in account B
  // render as "linked" in A's reconcile view, even though A's own statement
  // had nothing for it — making a half-reconciled transfer read as
  // already-done. The same-account guard in `linkTransactionToBank` blocks new
  // cross-account links; this bank-side join filter also hides any pre-existing
  // cross-account links from the per-account view without a data migration.
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
    .innerJoin(
      schema.bankTransactions,
      eq(
        schema.bankTransactions.id,
        schema.transactionBankLinks.bankTransactionId,
      ),
    )
    .where(
      and(
        eq(schema.transactionBankLinks.userId, userId),
        eq(schema.transactions.accountId, accountId),
        eq(schema.bankTransactions.accountId, accountId),
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

// 2-decimal score rounding (FINLYNQ-145 — delegates to the shared round2).
const roundScore = round2;

function roundDelta(d: number): number {
  return Math.round(d * 10000) / 10000;
}

// ─── Auto-pilot rule firing (Phase 4, 2026-05-27) ────────────────────────
//
// The Auto-pilot pipeline (accounts.mode='auto') fires transaction-rules at
// upload time. The helper below is the canonical entry point: the upload
// route calls it with the set of bank rows it just inserted; the helper
// loads each row + its account's rules, fires applyRules, and (when
// `autoMaterialize=true`) writes a paired `transactions` + `transaction_
// bank_links` row inside one DB transaction per matched bank row.
//
// Idempotent — bank rows that already have a `transaction_bank_links` row
// are skipped silently. Re-running the helper on the same batch produces
// no duplicate ledger rows. This is load-bearing for the
// "rules fire at upload OR /reconcile materialize" invariant: if a user
// edits a rule and re-runs the upload (or flips an account from
// Manual→Auto post-hoc and a future ticket replays bank rows), the
// helper safely no-ops on the already-linked ones.
//
// Audit invariants honored (all per CLAUDE.md + sign-category, audit-trio,
// invalidateUser):
//   - `source = 'auto_rule'` — distinct attribution from `manual` (Approve
//      click) and `reconcile_link` (Manual lens materialize). New enum
//      value added in `scripts/migrations/20260527_transactions_source_auto_rule.sql`
//      and `src/lib/tx-source.ts`.
//   - `import_hash` copied VERBATIM from the bank row. Never recomputed.
//   - `payee` re-encrypted under the user's DEK (transactions is user-tier
//      only; bank row may be service-tier from the email webhook path).
//   - Investment-account guard — refuses to materialize into an investment
//      account (would need a `portfolio_holding_id` which this surface
//      doesn't collect). Returns `matched: false` with a logged skip.
//   - Sign-vs-category invariant validated BEFORE INSERT. Mismatch logs a
//      warning and skips materialization for that row; the bank row stays
//      in "To categorize" so the user can pick a different category.
//   - tx + link INSERTs share one DB transaction per bank row.
//   - `invalidateUser(userId)` after the loop closes so MCP tx cache is
//      fresh on the next read.

export interface ApplyRulesToBankRowsOptions {
  /** When true, matched rules trigger a `transactions` + link INSERT for
   *  that bank row with source='auto_rule'. When false, the helper just
   *  reports which rows matched without writing anything (planning mode). */
  autoMaterialize?: boolean;
}

export interface ApplyRulesPerRowResult {
  bankRowId: string;
  matched: boolean;
  /** Set when matched + autoMaterialize=true + INSERT succeeded. */
  transactionId?: number;
  /** Reason a matched row was skipped despite autoMaterialize=true
   *  (e.g. 'already_linked', 'investment_account', 'sign_category_mismatch',
   *  'no_set_category_action', 'possible_ledger_duplicate'; or a transfer-rule
   *  code 'transfer_self' / 'transfer_inflow' / 'transfer_investment_dest' /
   *  'transfer_dest_not_found' / 'transfer_write_failed'). Absent on clean
   *  matches. */
  skipReason?: string;
  /** When skipReason='possible_ledger_duplicate', the id of the existing
   *  unlinked ledger transaction this bank row appears to duplicate. */
  duplicateOfTransactionId?: number;
}

export interface ApplyRulesToBankRowsResult {
  /** Number of bank rows that materialized to `transactions` this run. */
  materialized: number;
  /** Number of bank rows whose payee/amount/etc matched at least one
   *  active rule (regardless of autoMaterialize). */
  rulesFired: number;
  /** Number of bank rows NOT materialized because they match an existing
   *  unlinked ledger transaction (date+amount within the reconcile
   *  thresholds, or an import_hash hit). Left as bank rows so the user can
   *  link-to-existing or keep-separate instead of getting a silent duplicate. */
  possibleDuplicates: number;
  perRow: ApplyRulesPerRowResult[];
}

/**
 * Fire user-configured transaction rules against a batch of bank rows.
 *
 * Called from:
 *   - `POST /api/import/staging/upload` (Auto-pilot account branch) — with
 *     `autoMaterialize=true` so matched rows land in `transactions`
 *     immediately and surface as "Reconciled · rule" on /inbox.
 *
 * NOT called from the Manual-lens /reconcile path. That surface still
 * uses the inline `applyRules` call inside `computeReconcileForAccount`
 * which decorates `bankTransactions[].suggestedCategoryId` for the
 * materialize dialog — the user clicks Create to commit. We keep both
 * paths so the Manual lens stays explicit (no silent ledger writes).
 *
 * @param userId           — owner of every bank row in the batch.
 * @param bankRowIds       — UUIDs from `bank_transactions.id`. Cross-tenant
 *                           guard via `userId` in the SELECT. Empty array
 *                           returns a zero-result.
 * @param dek              — required when `autoMaterialize=true` (writes
 *                           are user-tier). Pass `null` for planning mode.
 * @param opts.autoMaterialize — write the matched row to `transactions`.
 */
export async function applyRulesToBankRows(
  userId: string,
  bankRowIds: string[],
  dek: Buffer | null,
  opts?: ApplyRulesToBankRowsOptions,
): Promise<ApplyRulesToBankRowsResult> {
  const autoMaterialize = opts?.autoMaterialize === true;
  const perRow: ApplyRulesPerRowResult[] = [];
  if (bankRowIds.length === 0) {
    return { materialized: 0, rulesFired: 0, possibleDuplicates: 0, perRow };
  }
  if (autoMaterialize && !dek) {
    throw new Error(
      "applyRulesToBankRows: DEK is required when autoMaterialize=true",
    );
  }

  // Load active rules once; the matcher is pure so we hand the same array
  // to every bank row. Rules are decrypted with the same DEK that decodes the
  // bank-row payees below (2026-06-01) — both are required to match.
  const activeRules = await loadActiveRulesForReconcile(userId, dek);

  // Load the bank rows + their account is_investment flag. Cross-tenant
  // 404 guard via `userId` on the SELECT.
  const bankRows = await db
    .select({
      id: schema.bankTransactions.id,
      accountId: schema.bankTransactions.accountId,
      date: schema.bankTransactions.date,
      amount: schema.bankTransactions.amount,
      currency: schema.bankTransactions.currency,
      enteredAmount: schema.bankTransactions.enteredAmount,
      enteredCurrency: schema.bankTransactions.enteredCurrency,
      enteredFxRate: schema.bankTransactions.enteredFxRate,
      quantity: schema.bankTransactions.quantity,
      payee: schema.bankTransactions.payee,
      note: schema.bankTransactions.note,
      tags: schema.bankTransactions.tags,
      ticker: schema.bankTransactions.ticker,
      securityName: schema.bankTransactions.securityName,
      encryptionTier: schema.bankTransactions.encryptionTier,
      importHash: schema.bankTransactions.importHash,
      fitId: schema.bankTransactions.fitId,
    })
    .from(schema.bankTransactions)
    .where(
      and(
        eq(schema.bankTransactions.userId, userId),
        inArray(schema.bankTransactions.id, bankRowIds),
      ),
    )
    .all();

  // Pre-load already-linked bank ids for idempotency. Re-running the
  // helper on a partial-success batch shouldn't double-materialize.
  const alreadyLinked = new Set<string>();
  if (bankRowIds.length > 0) {
    const links = await db
      .select({ bankTransactionId: schema.transactionBankLinks.bankTransactionId })
      .from(schema.transactionBankLinks)
      .where(
        and(
          eq(schema.transactionBankLinks.userId, userId),
          inArray(schema.transactionBankLinks.bankTransactionId, bankRowIds),
        ),
      )
      .all();
    for (const l of links) alreadyLinked.add(l.bankTransactionId);
  }

  // Pre-load account is_investment so we can refuse cleanly. Most batches
  // are single-account; one extra SELECT is fine.
  const accountIds = Array.from(new Set(bankRows.map((b) => b.accountId)));
  const accountInvestmentMap = new Map<number, boolean>();
  if (accountIds.length > 0) {
    const accts = await db
      .select({
        id: schema.accounts.id,
        isInvestment: schema.accounts.isInvestment,
      })
      .from(schema.accounts)
      .where(
        and(
          eq(schema.accounts.userId, userId),
          inArray(schema.accounts.id, accountIds),
        ),
      )
      .all();
    for (const a of accts) accountInvestmentMap.set(a.id, a.isInvestment);
  }

  let rulesFired = 0;
  let materialized = 0;
  let possibleDuplicates = 0;

  // ─── Possible-ledger-duplicate detection (2026-06-04) ────────────────────
  // Bank-side + staging-side dedup (import_hash / fitId) does NOT catch a row
  // that matches a transaction already in the LEDGER but with no bank lineage
  // (e.g. a manually-entered tx, or one whose bank row was deleted). In
  // Auto-pilot that produced a silent duplicate. We reuse the SAME match
  // engine /reconcile uses (exact-hash + fuzzy date/amount within the user's
  // thresholds) to find batch rows that match an existing UNLINKED ledger tx,
  // and refuse to auto-materialize them — they stay as bank rows flagged
  // 'possible_ledger_duplicate' so the To-categorize / To-approve cards can
  // surface a "link to existing vs keep separate" choice. Only runs in the
  // autoMaterialize path (the /reconcile preview path already shows matches).
  const ledgerDupTxByBank = new Map<string, number>();
  if (autoMaterialize) {
    const batchBankIds = new Set(bankRows.map((b) => b.id));
    const distinctAccountIds = Array.from(
      new Set(bankRows.map((b) => b.accountId)),
    );
    for (const acctId of distinctAccountIds) {
      try {
        const recon = await computeReconcileForAccount({
          userId,
          dek,
          accountId: acctId,
        });
        // Use the STRICT per-row duplicate signal (exact hash / exact amount +
        // close date), NOT the loose ±$50 greedy `suggestions` layer — a true
        // duplicate has the same amount, and we must not auto-block on a loose
        // fuzzy near-match.
        for (const bankId of batchBankIds) {
          const dupTxId = recon.bankTransactions[bankId]?.duplicateOfTransactionId;
          if (dupTxId != null) ledgerDupTxByBank.set(bankId, dupTxId);
        }
      } catch (err) {
        // Defensive: a dup-scan failure must never block the upload. Worst
        // case we fall back to today's behavior (no ledger-dup flag).

        console.error("[applyRulesToBankRows] ledger-dup scan failed", {
          accountId: acctId,
          err,
        });
      }
    }
  }

  // Diagnostic — single-line summary at INFO level, scoped to the
  // autoMaterialize path so /reconcile's per-snapshot calls don't spam
  // the journal. The Phase-4 dev-launch repro chased a "0 of N matched"
  // outcome that turned out to be a CSV parser short-circuit dropping
  // payees before they reached the matcher; keeping this trace makes a
  // future similar issue debuggable without rebuilding the helper.
  if (autoMaterialize) {

    console.log("[applyRulesToBankRows] start", {
      userId,
      bankRowCount: bankRows.length,
      activeRuleCount: activeRules.length,
    });
  }

  for (const bank of bankRows) {
    if (alreadyLinked.has(bank.id)) {
      perRow.push({
        bankRowId: bank.id,
        matched: false,
        skipReason: "already_linked",
      });
      continue;
    }

    // Possible ledger duplicate — refuse to auto-create a second ledger entry
    // for a transaction the user already has. Leave the bank row unlinked so
    // the inbox card surfaces a "link to existing / keep separate" choice.
    const dupTxId = ledgerDupTxByBank.get(bank.id);
    if (dupTxId != null) {
      possibleDuplicates += 1;
      perRow.push({
        bankRowId: bank.id,
        matched: false,
        skipReason: "possible_ledger_duplicate",
        duplicateOfTransactionId: dupTxId,
      });
      continue;
    }

    const payeePlain = decodeBankString(bank.encryptionTier, dek, bank.payee);
    const tickerPlain = decodeBankString(bank.encryptionTier, dek, bank.ticker);
    const securityNamePlain = decodeBankString(bank.encryptionTier, dek, bank.securityName);
    const match = applyRules(
      {
        payee: payeePlain,
        amount: bank.amount,
        accountId: bank.accountId,
        date: bank.date,
        // FINLYNQ-208 — investment-import captured fields for ticker /
        // security_name / quantity conditions.
        ticker: tickerPlain,
        securityName: securityNamePlain,
        quantity: bank.quantity,
      },
      activeRules,
    );
    if (!match) {
      if (autoMaterialize && activeRules.length > 0 && (!payeePlain || payeePlain === "")) {
        // Surface the most common cause: payee fell through as empty
        // string (the 2026-05-27 CSV-parser bug). Bounded — only when
        // payee is actually empty, so the journal stays readable for
        // healthy uploads.

        console.warn("[applyRulesToBankRows] empty-payee skip", {
          bankRowId: bank.id,
          amount: bank.amount,
        });
      }
      perRow.push({ bankRowId: bank.id, matched: false });
      continue;
    }
    rulesFired += 1;

    // Apply the rule's FULL pure-action patch (set_category + set_tags +
    // rename_payee + set_entered_currency), not just the primary action — so a
    // multi-action rule materializes ALL of its modifiers, consistent with the
    // staged / uncategorized paths (FINLYNQ-208, "support multiple actions").
    const patch = computePureActionPatch(match.actions);

    // FINLYNQ-208 — investment-op rule(s). Take precedence over category /
    // transfer actions: when the matched rule records portfolio op(s), we run
    // the sanctioned investment chokepoint (which lifts the investment-account
    // refusal because it resolves/creates the position + sleeve). Planning mode
    // (autoMaterialize=false) just reports the match. Pure modifiers
    // (rename_payee / set_tags) ride along as overrides onto the recorded op(s).
    //
    // A rule may carry MULTIPLE record_investment_op actions (e.g. buy + deposit)
    // — execute EVERY one, not just the first ("support multiple actions"). Each
    // op materializes its own rows + links to the bank row.
    const invOps = match.actions.filter(
      (a): a is RecordInvestmentOpAction => a.kind === "record_investment_op",
    );
    if (invOps.length > 0) {
      if (!autoMaterialize) {
        perRow.push({ bankRowId: bank.id, matched: true });
        continue;
      }
      // dek is non-null here — guarded by the autoMaterialize=>dek check.
      let firstTxId: number | undefined;
      let lastFailCode: string | undefined;
      let okCount = 0;
      for (const invOp of invOps) {
        const result = await materializeBankRowAsPortfolioOp({
          userId,
          dek: dek!,
          bankTransactionId: bank.id,
          action: invOp,
          overrides: { payee: patch.payee, tags: patch.tags },
        });
        if (result.ok) {
          okCount += 1;
          if (firstTxId == null) firstTxId = result.linkedTransactionId;
        } else {
          lastFailCode = result.code;
        }
      }
      if (okCount > 0) {
        materialized += 1;
        perRow.push({ bankRowId: bank.id, matched: true, transactionId: firstTxId });
      } else {
        perRow.push({
          bankRowId: bank.id,
          matched: true,
          skipReason: `investment_op_${lastFailCode ?? "failed"}`,
        });
      }
      continue;
    }

    const categoryId = patch.categoryId ?? null;
    if (categoryId == null) {
      // Rule matched but its actions don't include a `set_category`. A
      // transfer-only rule (`create_transfer`, no `set_category`) is the
      // common case here — auto-route it through the shared transfer
      // materializer so Auto-pilot accounts get transfer pairs written
      // immediately (mirrors the Manual materialize-dialog fix). Outflow
      // rows only; the helper refuses inflow / self / investment-dest.
      const transferDest = pickTransferDestFromActions(match.actions);
      if (autoMaterialize && transferDest != null) {
        // dek is non-null here — guarded by the autoMaterialize=>dek check
        // at the top of the function.
        const payeePlain = decodeBankString(bank.encryptionTier, dek, bank.payee);
        const result = await materializeBankRowAsTransfer({
          userId,
          dek: dek!,
          bank: {
            id: bank.id,
            accountId: bank.accountId,
            date: bank.date,
            amount: bank.amount,
            currency: bank.currency,
          },
          payeePlain,
          destAccountId: transferDest,
          txSource: "auto_rule",
        });
        if (result.ok) {
          materialized += 1;
          perRow.push({
            bankRowId: bank.id,
            matched: true,
            transactionId: result.fromTransactionId,
          });
        } else {
          perRow.push({
            bankRowId: bank.id,
            matched: true,
            skipReason: result.code,
          });
        }
        continue;
      }
      // No transfer destination (or planning mode) — can't materialize
      // without a category. Skip and let the user categorize manually via
      // /inbox To-categorize. Non-autoMaterialize callers just report the
      // match.
      perRow.push({
        bankRowId: bank.id,
        matched: true,
        skipReason: "no_set_category_action",
      });
      continue;
    }

    if (!autoMaterialize) {
      perRow.push({ bankRowId: bank.id, matched: true });
      continue;
    }

    if (accountInvestmentMap.get(bank.accountId) === true) {
      perRow.push({
        bankRowId: bank.id,
        matched: true,
        skipReason: "investment_account",
      });
      continue;
    }

    // Sign-vs-category invariant — same enforcement as /materialize and
    // /approve. Mismatch logs a skip and leaves the bank row in the
    // unlinked pool so the user can pick a different category.
    const violation = await validateSignVsCategoryById(
      userId,
      dek,
      categoryId,
      bank.amount,
    );
    if (violation) {
      perRow.push({
        bankRowId: bank.id,
        matched: true,
        skipReason: "sign_category_mismatch",
      });
      continue;
    }

    // Cross-tenant FK guard on categoryId. The rule's action was already
    // ownership-checked at rule-create time, but defensive re-check costs
    // nothing here and matches the materialize/approve pattern.
    const cat = await db
      .select({ id: schema.categories.id })
      .from(schema.categories)
      .where(
        and(
          eq(schema.categories.id, categoryId),
          eq(schema.categories.userId, userId),
        ),
      )
      .limit(1);
    if (!cat[0]) {
      perRow.push({
        bankRowId: bank.id,
        matched: true,
        skipReason: "category_not_owned",
      });
      continue;
    }

    const notePlain = decodeBankString(bank.encryptionTier, dek, bank.note);
    const tagsPlain = decodeBankString(bank.encryptionTier, dek, bank.tags);

    // Apply the rule's pure modifiers (rename_payee / set_tags /
    // set_entered_currency) on top of the bank row's own values. A modifier
    // that the rule didn't set falls back to the bank row's value.
    const effectivePayee = patch.payee ?? payeePlain;
    const effectiveTags = patch.tags ?? tagsPlain;
    const effectiveEnteredCurrency = patch.enteredCurrency ?? bank.enteredCurrency;

    // INSERT tx + link in a single DB transaction. The dek non-null
    // assertion is safe — guarded above by the autoMaterialize=>dek check.
    const dekForWrite = dek!;
    try {
      const inserted = await db.transaction(async (tx) => {
        const txRow = await tx
          .insert(schema.transactions)
          .values({
            userId,
            date: bank.date,
            accountId: bank.accountId,
            categoryId,
            currency: bank.currency,
            amount: bank.amount,
            enteredCurrency: effectiveEnteredCurrency,
            enteredAmount: bank.enteredAmount,
            enteredFxRate: bank.enteredFxRate,
            quantity: bank.quantity,
            payee: encryptField(dekForWrite, effectivePayee) ?? "",
            note: encryptField(dekForWrite, notePlain) ?? "",
            tags: encryptField(dekForWrite, effectiveTags) ?? "",
            importHash: bank.importHash,
            fitId: bank.fitId,
            bankTransactionId: bank.id,
            // Auto-pilot rule-fired attribution. Allowed by the CHECK
            // constraint update in
            // scripts/migrations/20260527_transactions_source_auto_rule.sql.
            source: "auto_rule",
            // createdAt + updatedAt + enteredAt all default to NOW() via
            // the column defaults — no need to set explicitly.
          })
          .returning({ id: schema.transactions.id });

        await tx.insert(schema.transactionBankLinks).values({
          userId,
          transactionId: txRow[0].id,
          bankTransactionId: bank.id,
          linkType: "primary",
          source: "auto_rule",
        });

        return txRow[0].id;
      });

      materialized += 1;
      perRow.push({
        bankRowId: bank.id,
        matched: true,
        transactionId: inserted,
      });
    } catch (err) {

      console.error("[applyRulesToBankRows] materialize failed", {
        bankRowId: bank.id,
        err,
      });
      perRow.push({
        bankRowId: bank.id,
        matched: true,
        skipReason: "insert_failed",
      });
    }
  }

  if (materialized > 0) {
    // Per-user MCP tx cache must be invalidated after any tx-mutating
    // write so Claude doesn't read stale payees. Bundled at the end of
    // the loop instead of per-row to avoid N invalidations on a big batch.
    invalidateUser(userId);
  }

  return { materialized, rulesFired, possibleDuplicates, perRow };
}

/**
 * Tier-aware decrypt for one of the encrypted text columns on
 * `bank_transactions`. Mirrors the matching helper in /api/reconcile/
 * materialize/route.ts and /api/bank-transactions/[bankId]/approve/route.ts.
 * Kept inline here so the helper has no cross-route import dependency.
 */
function decodeBankString(
  tier: string | null,
  dek: Buffer | null,
  value: string | null,
): string | null {
  if (value == null || value === "") return value;
  if ((tier ?? "user") === "user") {
    if (!dek) return null;
    return tryDecryptField(dek, value, "bank_transactions");
  }
  try {
    return decryptStaged(value);
  } catch {
    return null;
  }
}
