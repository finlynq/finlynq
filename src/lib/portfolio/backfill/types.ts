/**
 * Types for the transaction-canonicalization backfill pipeline.
 *
 * Pipeline: PLAN (pure) → REVIEW (UI) → APPLY (DB tx + lot replay) → UNDO.
 * Full mechanics: pf-app/docs/architecture/backfill.md.
 *
 * Plan-stage code lives in this directory and is pure — no DB, no FS, no
 * network. The runtime read of `LedgerSnapshot` from the DB and the apply
 * path live in apply.ts.
 */

import type { TransactionSource } from "@/lib/tx-source";

// ─── Snapshot shapes (planner inputs, read-only) ──────────────────────

/**
 * One transaction row as the planner sees it. Subset of
 * `TxRowForLots` plus a few extras the planner needs (linkId for transfer
 * pair detection, isInvestmentAccount denormalized for fast filtering).
 */
export interface SnapshotTx {
  id: number;
  userId: string;
  date: string;          // YYYY-MM-DD
  accountId: number | null;
  categoryId: number | null;
  currency: string;
  amount: number;
  quantity: number | null;
  portfolioHoldingId: number | null;
  tradeLinkId: string | null;
  linkId: string | null;
  source: TransactionSource;
  kind: string | null;
}

export interface SnapshotHolding {
  id: number;
  accountId: number;
  currency: string;
  isCash: boolean;
  /** Decrypted display name when available; null in stdio MCP / pre-DEK contexts. */
  displayName: string | null;
}

export interface SnapshotAccount {
  id: number;
  currency: string;
  isInvestment: boolean;
  displayName: string | null;
}

export interface LedgerSnapshot {
  userId: string;
  txs: SnapshotTx[];
  holdings: SnapshotHolding[];
  accounts: SnapshotAccount[];
  dividendsCategoryId: number | null;
  /**
   * tx ids that already have an open lot row in `holding_lots` (open_tx_id).
   * Populated by the runtime snapshot loader; pure tests can pass an empty
   * Set. Used by Pass 0 (missing_lot detection) to find canonical buys
   * whose lots weren't created.
   */
  lotsByOpenTxId: Set<number>;
  /**
   * tx ids that already have a closure row in `holding_lot_closures`
   * (close_tx_id). Used by Pass 0 to find canonical sells whose closures
   * weren't recorded.
   */
  closuresByCloseTxId: Set<number>;
}

// ─── Run config (preflight choices) ────────────────────────────────────

/** Per-run preflight mode (S8): how to handle orphan stock legs. */
export type BackfillMode = "refuse_orphans" | "synthesize_orphans";

export interface BackfillScopeFilter {
  accountIds?: number[];
  stagedImportId?: string;
  dateFrom?: string;  // YYYY-MM-DD, inclusive
  dateTo?: string;    // YYYY-MM-DD, inclusive
}

export interface BackfillRunConfig {
  mode: BackfillMode;
  scope: BackfillScopeFilter;
}

// ─── Proposal output ──────────────────────────────────────────────────

export type ProposalKind =
  | "buy_pair"
  | "sell_pair"
  | "dividend"
  | "fx_pair"
  | "brokerage_deposit_pair"
  | "brokerage_withdrawal_pair"
  | "classify_only"
  | "drift"
  | "orphan_stock_leg"
  /**
   * First transaction for a (holding, account) with qty > 0 and no matching
   * cash leg — almost certainly an opening balance carried in from another
   * platform. Apply records the row as a lot at the entered cost basis;
   * no cash-side impact. User can reject if it's actually a normal orphan.
   */
  | "opening_balance"
  /**
   * Dividend reinvestment (DRIP): category=Dividends, qty>0, amount>0,
   * qty≈amount (share count equals cash value because the dividend
   * dollars buy shares at the prevailing price; not literally true but a
   * decent heuristic when the source data records both numbers as the
   * dollar value of the distribution). Likely the underlying
   * `portfolio_holding_id` points to a cash sleeve OR to the wrong stock
   * — the row needs the user to pick the correct stock holding before
   * apply. Apply stamps `kind='dividend'`, switches
   * `portfolio_holding_id` to `chosen_holding_id`, opens a lot via the
   * standard `applyLotEffectsForTx` replay at
   * `costPerShare = amount / qty`, `origin='reinvest_div'`.
   */
  | "dividend_reinvestment"
  /**
   * Already-canonical row that should have a lot row (or closure) in
   * holding_lots / holding_lot_closures but doesn't. Typical cause:
   * row predates the lot system or was written via a path that
   * bypassed `applyLotEffectsForTx`. Apply runs the lot hook directly
   * without UPDATEing the row — the row is correct, the lot just
   * needs to be created. See `lotAction` on the proposal for which
   * lot operation (open / close / transfer) to run.
   */
  | "missing_lot";

export type Confidence = "high" | "medium" | "low" | "refused";

/**
 * Patch payload for an UPDATE-in-place on an existing `transactions` row.
 * Only fields the apply path touches; everything else stays as-is. The
 * `updated_at = NOW()` bump happens in the apply route, not encoded here.
 */
export interface ReplacementRow {
  txId: number;
  amount?: number;
  kind?: string;
  tradeLinkId?: string;
  linkId?: string;
}

/**
 * Net-new row to INSERT in synthesize-mode orphans or drift variant A.
 * The apply path tags `source='backfill_synth'` automatically.
 */
export interface SynthesizedRow {
  date: string;
  accountId: number;
  categoryId: number | null;
  portfolioHoldingId: number | null;
  currency: string;
  amount: number;
  quantity: number | null;
  kind: string;
  tradeLinkId: string | null;
  linkId: string | null;
  /** Why this row was fabricated; surfaced in the UI for transparency. */
  synthReason: string;
}

export interface ProposalDeltas {
  /** Net change to account-balance sums after apply. 0 for clean pairs. */
  balance: number;
  /** Per-holding qty deltas the lot engine will record. */
  lots: Array<{ holdingId: number; qtyDelta: number }>;
  /** Estimated realized gain in user's base currency (best-effort at plan time). */
  realizedGainBase: number | null;
}

/**
 * For drift proposals (S4): each variant carries its own replacement +
 * synthesized payload. The user picks via `variant_choice` at review
 * time; the apply path reads the matching key out of `replacement_rows_json`.
 */
export interface DriftVariant {
  replacement: ReplacementRow[];
  synthesized: SynthesizedRow[];
  deltas: ProposalDeltas;
  /** Human-readable explanation rendered in the right pane. */
  explanation: string;
}

export interface Proposal {
  kind: ProposalKind;
  confidence: Confidence;
  /** Filled when `confidence === 'refused'`. */
  refusalReason?: string;
  /** One-line LEFT-pane label. */
  summary: string;
  /** transactions.id values this proposal displaces. */
  existingRowIds: number[];
  /** Apply patch for non-drift proposals. Empty for pure-synthesize proposals. */
  replacement: ReplacementRow[];
  /** Net-new rows. Empty for non-synthesize proposals. */
  synthesized: SynthesizedRow[];
  /** Drift proposals only. Keys: 'separate_fee_row' | 'absorb_into_cost'. */
  variants?: { separate_fee_row: DriftVariant; absorb_into_cost: DriftVariant };
  /**
   * Set when the proposal cannot be applied without a user choice. For
   * `dividend_reinvestment` proposals: `'holding_picker'` — the right pane
   * surfaces a dropdown of stock holdings, the user picks one, and the
   * apply route reads `chosen_holding_id` from the proposal row. Mirror
   * pattern of the existing `variant_choice` field on drift proposals.
   */
  requiresUserChoice?: "holding_picker";
  /**
   * Pre-suggested holding ids for `requiresUserChoice='holding_picker'`
   * proposals — fuzzy-matched on row note/tags against existing holding
   * display names. UI pre-selects the top candidate. Empty array if no
   * good matches; user picks freely from the full holdings list.
   */
  candidateHoldingIds?: number[];
  /**
   * For `missing_lot` proposals: which lot operation the apply path
   * should run via `applyLotEffectsForTx`. Derived from the row's
   * `kind` at plan time so the UI can label the proposal clearly.
   */
  lotAction?: "open" | "close" | "transfer";
  /**
   * For `dividend_reinvestment` proposals: planner-suggested default
   * variant. UI pre-selects this on first render; user can override
   * before approving. Persisted to `backfill_proposals.dividend_variant`
   * once the user picks. Apply route refuses if NULL.
   *
   * 'cash_dividend' — row is a real cash dividend; apply UPDATEs
   *                   kind='dividend', sets quantity=0, sets
   *                   portfolio_holding_id=chosen. No lot opens.
   * 'drip'          — row is a share reinvestment; apply UPDATEs
   *                   kind='dividend', sets portfolio_holding_id=chosen.
   *                   Qty preserved. Lot replay opens via
   *                   applyLotEffectsForTx at costPerShare=amount/qty.
   */
  suggestedDividendVariant?: "cash_dividend" | "drip";
  deltas: ProposalDeltas;
  /**
   * Proposal indices (within the same plan result) this one depends on.
   * Sell proposals depend on the Buy proposals whose lots they FIFO-close
   * from. The apply route refuses to apply a child without its parents.
   *
   * Indices into the returned Proposal[] array — converted to DB IDs at
   * persist time.
   */
  dependsOn: number[];
}

// ─── Internal detector predicates (exported for unit tests) ───────────

export const PORTFOLIO_OP_KINDS = new Set([
  "buy", "sell",
  "buy_cash_leg", "sell_cash_leg",
  "fx_from", "fx_to", "fx_fee",
  "brokerage_deposit_in", "brokerage_deposit_out",
  "brokerage_withdrawal_in", "brokerage_withdrawal_out",
  "dividend", "interest",
  "portfolio_income", "portfolio_expense",
  "in_kind_transfer_in", "in_kind_transfer_out",
]);

/**
 * Pair-less canonical kinds: rows that are in their final Phase-2 shape
 * even though they have NO `trade_link_id` (and NO `link_id`). Shared with
 * the coverage endpoint at /api/settings/backfill/coverage so the planner
 * and the coverage dashboard agree on which rows are canonical.
 *
 * `opening_balance` is in this set: carried-in standalone positions have
 * no cash leg by design (the user transferred the position from another
 * platform; no money moved in Finlynq).
 *
 * `balance_adjustment` is in this set too (FINLYNQ-206): it is a pair-less
 * standalone balance entry. The 20260627 migration re-tags the legacy
 * multi-row investment `opening_balance` rows to `balance_adjustment` so the
 * one-opening-balance-per-account unique index can build — those rows must
 * stay canonical to the planner/coverage (no cash leg to pair), exactly like
 * `opening_balance`, or they'd be re-proposed as orphan_stock_leg.
 */
export const PAIRLESS_CANONICAL_KINDS = new Set([
  "dividend",
  "interest",
  "portfolio_income",
  "portfolio_expense",
  "opening_balance",
  "balance_adjustment",
]);

/**
 * A row is "already canonical" if its `kind` is set AND the row is in
 * its final Phase-2 shape — either a pair-less kind (no `trade_link_id`
 * needed) or a kind that pairs through `trade_link_id` / `link_id`.
 *
 * Symmetry with /api/settings/backfill/coverage's SQL predicate is
 * load-bearing: divergence between the two surfaces leads to the
 * "coverage says N pending, planner returns 0 proposals" bug surfaced
 * 2026-06-02 (HANDOVER_2026-06-02_BACKFILL_REVIEW_BUGS.md). The strict
 * predicate is safe because opening_balance proposals now stamp the
 * distinct `kind='opening_balance'` literal — a row with `kind='buy'`
 * and no trade_link_id is unambiguously a broken pair to be re-proposed,
 * not a carried-in position to be left alone.
 */
export function isAlreadyCanonical(tx: SnapshotTx): boolean {
  if (tx.kind == null || tx.kind === "") return false;
  if (PAIRLESS_CANONICAL_KINDS.has(tx.kind)) return true;
  return tx.tradeLinkId != null || tx.linkId != null;
}
