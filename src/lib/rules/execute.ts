/**
 * FINLYNQ-84 — Rule action execution.
 *
 * Split into two phases:
 *
 * 1. `computePureActionPatch(actions, txn) → PureActionPatch` — applies
 *    in-row actions only (`set_category`, `set_tags`, `rename_payee`,
 *    `set_entered_currency`, `set_portfolio_holding`). Pure (no DB I/O),
 *    cheap to call from preview / live-preview surfaces.
 *
 * 2. `executeSideEffectActions(actions, txnRow, ctx)` — handles the two
 *    action kinds that mutate rows other than the matched txn:
 *    `set_account` (UPDATE with investment-account guard +
 *    `getOrCreateCashHolding` default) and `create_transfer` (delegates to
 *    `createTransferPair`, which mints `link_id` server-side per the
 *    four-check transfer-pair rule).
 *
 * Load-bearing invariants:
 * - `link_id` / `trade_link_id` are server-generated only. `create_transfer`
 *   action carries only `destAccountId`; the mint happens inside
 *   `createTransferPair`.
 * - Side-effect actions are refused on paths that only have a committed row
 *   in scope (`apply_rules_to_uncategorized`, stdio `autoCategory`). The
 *   refusal is surfaced via `actionHasSideEffects()` / `ruleHasSideEffects()`
 *   in `rules/schema.ts`. This function trusts its caller to gate.
 * - Sign-vs-category (issue #212) is checked at the actual UPDATE site by
 *   the caller, NOT here. computePureActionPatch is pure.
 * - `updated_at = NOW()` + `source` stamping is the caller's responsibility
 *   on the UPDATE wrapping this patch (audit trio, issue #28).
 * - `invalidateUserTxCache(userId)` after the batch is also the caller's
 *   responsibility.
 *
 * NOTE: `executeSideEffectActions()` is wired in Phase 6 of FINLYNQ-84.
 * Phase 3 only requires the pure patcher.
 */
import type { Action } from "./schema";
import type { TransactionInput } from "../auto-categorize";

export type PureActionPatch = {
  categoryId?: number;
  tags?: string;
  /** rename_payee target. */
  payee?: string;
  enteredCurrency?: string;
  portfolioHoldingId?: number;
};

/**
 * Apply pure actions to the matched txn's patch. Side-effect actions
 * (`set_account`, `create_transfer`) are ignored — they need approve-time
 * context (`executeSideEffectActions`).
 *
 * Action order matters when two actions write the same field; last-wins
 * matches the array order to keep deterministic semantics.
 */
export function computePureActionPatch(
  actions: Action[],
  // txn is reserved for future field-templating (e.g. rename_payee using
  // a captured group from a regex condition). Today the patch is static
  // per-action so this param is unused; keep the signature for API stability.
  _txn?: TransactionInput,
): PureActionPatch {
  const patch: PureActionPatch = {};
  for (const a of actions) {
    switch (a.kind) {
      case "set_category":
        patch.categoryId = a.categoryId;
        break;
      case "set_tags":
        patch.tags = a.tags;
        break;
      case "rename_payee":
        patch.payee = a.to;
        break;
      case "set_entered_currency":
        patch.enteredCurrency = a.currency.toUpperCase();
        break;
      case "set_portfolio_holding":
        patch.portfolioHoldingId = a.holdingId;
        break;
      case "set_account":
      case "create_transfer":
        // Side-effect actions — handled separately.
        break;
      default: {
        // Exhaustiveness check.
        const _exhaustive: never = a;
        void _exhaustive;
      }
    }
  }
  return patch;
}

/**
 * Side-effect action execution context. Wired in Phase 6 of FINLYNQ-84.
 *
 * Stubbed today — surfaces a typed "not implemented" error if a caller invokes
 * it before Phase 6 lands. The Phase 3 callsites (staging approve materialization,
 * `apply_rules_to_uncategorized` refusal path) don't need this yet.
 */
export type SideEffectContext = {
  userId: string;
  dek: Buffer | null;
  source: "manual" | "import" | "mcp_http" | "mcp_stdio";
};

export type SideEffectActionResult = {
  /** Newly-created transaction ids (from create_transfer's pair). */
  created: number[];
  /** Mutated existing transaction ids (from set_account). */
  updated: number[];
};

/**
 * Phase 6 — apply side-effect actions to a committed txn row. Stub today;
 * concrete impl will wrap `createTransferPair` + an UPDATE with the
 * investment-account guard.
 */
export async function executeSideEffectActions(
  _actions: Action[],
  _txnRow: { id: number; accountId: number; amount: number; date: string; currency: string; categoryId: number | null },
  _ctx: SideEffectContext,
): Promise<SideEffectActionResult> {
  throw new Error(
    "executeSideEffectActions() not yet implemented — wired in FINLYNQ-84 phase 6",
  );
}
