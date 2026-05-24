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
  | "opening_balance";

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
 * A row is "already canonical" if its `kind` is set AND
 * (it doesn't expect pairing OR it has a trade_link_id).
 * Pair-less canonical shapes: dividend, interest, portfolio_income,
 * portfolio_expense, classify_only outputs.
 */
const PAIRLESS_CANONICAL_KINDS = new Set([
  "dividend", "interest", "portfolio_income", "portfolio_expense",
]);

export function isAlreadyCanonical(tx: SnapshotTx): boolean {
  if (!tx.kind) return false;
  if (PAIRLESS_CANONICAL_KINDS.has(tx.kind)) return true;
  return tx.tradeLinkId !== null || tx.linkId !== null;
}
