/**
 * Apply + Undo for the transaction-canonicalization backfill pipeline.
 *
 * APPLY (single DB transaction per proposal):
 *   1. Re-check dependency parents are applied first
 *   2. Snapshot displaced rows to backfill_audit
 *   3. UPDATE-in-place the existing transactions (audit-trio: updated_at = NOW())
 *   4. INSERT synthesized rows tagged source='backfill_synth'
 *   5. Replay applyLotEffectsForTx for every replaced + synthesized row
 *   6. invalidateUser(userId) for the MCP per-user tx cache
 *
 * UNDO (single DB transaction per proposal):
 *   1. Check for downstream closures (same pattern as cascadeDeleteForReplace)
 *   2. If blocked: return { ok: false, blockingClosureTxIds, blockingProposalIds }
 *   3. Otherwise: reverseLotsForDeleteHook for every tx in the proposal's scope
 *   4. Restore each row from backfill_audit.before_json
 *   5. DELETE any synthesized rows
 *   6. Mark proposal status='undone', invalidateUser
 *
 * Why UPDATE-in-place rather than DELETE+INSERT: preserves transactions.id,
 * created_at, import_hash (plaintext-payee invariant), and bank_transaction_id
 * lineage. All load-bearing per pf-app/docs/invariants.md. Synthesis is the
 * only path that creates net-new rows.
 */

import { and, eq, inArray } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { invalidateUser } from "@/lib/mcp/user-tx-cache";
import {
  applyLotEffectsForTx,
  buildLotContext,
  reverseLotsForDeleteHook,
  type LotContext,
} from "@/lib/portfolio/lots/write-hooks";
import { canEditPortfolioRow } from "@/lib/portfolio/operations";
import { resolveDividendsCategoryId } from "@/lib/dividends-category";
import { decryptName } from "@/lib/crypto/encrypted-columns";
import type {
  Confidence,
  DriftVariant,
  LedgerSnapshot,
  ProposalKind,
  ReplacementRow,
  SnapshotAccount,
  SnapshotHolding,
  SnapshotTx,
  SynthesizedRow,
} from "./types";

/**
 * Persisted proposal row shape — fetched from backfill_proposals.
 * Mirrors the Drizzle table definition. Inline interface (rather than
 * importing the table type) so we can document each field.
 */
interface PersistedProposal {
  id: number;
  runId: string;
  userId: string;
  proposalKind: ProposalKind;
  confidence: Confidence;
  refusalReason: string | null;
  summary: string;
  existingRowIds: number[];
  replacementRowsJson: unknown; // ReplacementRow[] OR DriftVariant pair (variant_choice picks one)
  synthesizedRowsJson: unknown; // SynthesizedRow[] | null
  dependsOnProposalIds: number[];
  variantChoice: string | null;
  /** Set for `dividend_reinvestment` proposals — the user-picked underlying
   *  stock holding. Apply route refuses without this; on apply, the
   *  existing row's portfolio_holding_id is UPDATEd to this id and
   *  kind='dividend' is stamped. */
  chosenHoldingId: number | null;
  /** Set for `dividend_reinvestment` proposals — 'cash_dividend' zeroes
   *  the qty and opens no lot; 'drip' keeps qty (as shares) and lets the
   *  lot replay open a lot at costPerShare=amount/qty. Refuse on NULL. */
  dividendVariant: "cash_dividend" | "drip" | null;
  /** Kind override (migration 20260609) — set ONLY for `orphan_stock_leg`
   *  proposals the user wants to apply with a hand-picked kind. NULL
   *  otherwise. When non-null the apply route dispatches to
   *  applyOrphanOverride() BEFORE the refused short-circuit. */
  chosenKind: OverrideKind | null;
  /** Paired-kind partner row when the user picks an existing unmatched
   *  candidate. NULL when chosenKind is pair-less or counterpartMode is
   *  'synth_new'. */
  chosenCounterpartTxId: number | null;
  chosenCounterpartMode: "link_existing" | "synth_new" | null;
  /** Underlying stock when chosenKind is portfolio_income/expense — apply
   *  swaps the row onto the matching cash sleeve and stamps
   *  related_holding_id. Mirror of cash_dividend branch of
   *  dividend_reinvestment. NULL otherwise. */
  chosenRelatedHoldingId: number | null;
  status: string;
}

/**
 * The 15 override-eligible kinds for refused `orphan_stock_leg` proposals.
 * 5 pair-less (apply does UPDATE-in-place on the orphan row alone) + 10
 * paired (the row + a counterpart that is either picked from existing
 * unmatched rows or synthesized as `source='backfill_synth'`).
 *
 * MUST stay in sync with the CHECK constraint on
 * backfill_proposals.chosen_kind (migration 20260609).
 */
export type OverrideKind =
  | "opening_balance"
  | "dividend"
  | "interest"
  | "portfolio_income"
  | "portfolio_expense"
  | "buy"
  | "sell"
  | "in_kind_transfer_in"
  | "in_kind_transfer_out"
  | "fx_from"
  | "fx_to"
  | "brokerage_deposit_in"
  | "brokerage_deposit_out"
  | "brokerage_withdrawal_in"
  | "brokerage_withdrawal_out";

export const OVERRIDE_PAIRLESS_KINDS = new Set<OverrideKind>([
  "opening_balance",
  "dividend",
  "interest",
  "portfolio_income",
  "portfolio_expense",
]);

export interface ApplyResult {
  ok: true;
  proposalId: number;
  updatedTxIds: number[];
  insertedTxIds: number[];
}

export interface ApplyRefusal {
  ok: false;
  code: string;
  message: string;
  blockingProposalIds?: number[];
  blockingClosureTxIds?: number[];
}

// ─── Apply ────────────────────────────────────────────────────────────

export async function applyProposal(
  proposalId: number,
  userId: string,
  dek: Buffer | null,
): Promise<ApplyResult | ApplyRefusal> {
  const proposal = await loadProposal(proposalId, userId);
  if (!proposal) {
    return { ok: false, code: "not_found", message: `Proposal ${proposalId} not found` };
  }
  if (proposal.status !== "pending" && proposal.status !== "approved") {
    return { ok: false, code: "wrong_status", message: `Proposal ${proposalId} is in status '${proposal.status}', cannot apply` };
  }
  // Kind override branch (migration 20260609) — when the user has picked a
  // chosenKind on a refused `orphan_stock_leg` proposal, dispatch to the
  // override path BEFORE the refused short-circuit. The override path runs
  // its own snapshot + UPDATE + lot-replay + invalidateUser flow because
  // the displaced shape is different from the planner-emitted replacement.
  if (
    proposal.proposalKind === "orphan_stock_leg" &&
    proposal.chosenKind != null
  ) {
    return applyOrphanOverride(proposal, userId, dek);
  }
  if (proposal.confidence === "refused") {
    return { ok: false, code: "refused_proposal", message: `Proposal ${proposalId} is refused (${proposal.refusalReason ?? "no reason"}); cannot apply` };
  }
  if (proposal.proposalKind === "drift" && !proposal.variantChoice) {
    return { ok: false, code: "drift_variant_missing", message: `Drift proposal requires a variant_choice ('separate_fee_row' or 'absorb_into_cost')` };
  }
  if (proposal.proposalKind === "dividend_reinvestment" && proposal.chosenHoldingId == null) {
    return {
      ok: false,
      code: "holding_choice_missing",
      message: `Dividend reinvestment proposal requires chosen_holding_id (the underlying stock the user picks)`,
    };
  }
  if (proposal.proposalKind === "dividend_reinvestment" && proposal.dividendVariant == null) {
    return {
      ok: false,
      code: "dividend_variant_missing",
      message: `Dividend reinvestment proposal requires a variant ('cash_dividend' or 'drip')`,
    };
  }

  // Server-side dependency check — every parent must already be applied.
  if (proposal.dependsOnProposalIds.length > 0) {
    const parents = await db
      .select({
        id: schema.backfillProposals.id,
        status: schema.backfillProposals.status,
      })
      .from(schema.backfillProposals)
      .where(inArray(schema.backfillProposals.id, proposal.dependsOnProposalIds));
    const unapplied = parents.filter((p) => p.status !== "applied").map((p) => p.id);
    if (unapplied.length > 0) {
      return {
        ok: false,
        code: "dependencies_unapplied",
        message: `Apply parent proposals first: [${unapplied.join(", ")}]`,
        blockingProposalIds: unapplied,
      };
    }
  }

  // Resolve replacement + synthesized payloads for the chosen variant (drift)
  // or the proposal's direct payload (non-drift).
  let replacement: ReplacementRow[];
  let synthesized: SynthesizedRow[];
  if (proposal.proposalKind === "drift") {
    const variants = proposal.replacementRowsJson as { separate_fee_row: DriftVariant; absorb_into_cost: DriftVariant };
    const chosen = variants[proposal.variantChoice as "separate_fee_row" | "absorb_into_cost"];
    replacement = chosen.replacement;
    synthesized = chosen.synthesized;
  } else {
    replacement = (proposal.replacementRowsJson as ReplacementRow[] | null) ?? [];
    synthesized = (proposal.synthesizedRowsJson as SynthesizedRow[] | null) ?? [];
  }

  const updatedTxIds: number[] = [];
  const insertedTxIds: number[] = [];

  // Stale-proposal guard (load-bearing — surfaced as a duplicate-lot bug
  // 2026-06-02). If a displaced row is already in canonical shape (kind +
  // PAIRLESS kind OR trade_link_id OR link_id), the proposal is stale: a
  // prior backfill run already canonicalized this row. Re-applying would
  // mint a second lot. Refuse.
  //
  // Mirrors `isAlreadyCanonical` from
  // src/lib/portfolio/backfill/types.ts — same predicate the planner uses
  // to skip candidates, and the coverage SQL uses to count canonical.
  // A row with kind='buy' and no trade_link_id is NOT canonical and CAN
  // be displaced (e.g., by a dividend_reinvestment proposal that
  // re-tags it kind='dividend' on a user-picked stock holding).
  //
  // Exception: missing_lot proposals operate on rows that ARE canonical
  // (that's the precondition the planner checked). The stale guard for
  // missing_lot is "lot has been created since planning" — handled
  // separately below.
  if (proposal.proposalKind !== "missing_lot") {
    const PAIRLESS_KINDS = new Set([
      "dividend",
      "interest",
      "portfolio_income",
      "portfolio_expense",
      "opening_balance",
    ]);
    const staleCheck = await db
      .select({
        id: schema.transactions.id,
        kind: schema.transactions.kind,
        tradeLinkId: schema.transactions.tradeLinkId,
        linkId: schema.transactions.linkId,
      })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.userId, userId),
          inArray(schema.transactions.id, proposal.existingRowIds),
        ),
      );
    const alreadyCanonical = staleCheck.filter(
      (r) =>
        r.kind != null &&
        r.kind !== "" &&
        (PAIRLESS_KINDS.has(r.kind) || r.tradeLinkId != null || r.linkId != null),
    );
    if (alreadyCanonical.length > 0) {
      return {
        ok: false,
        code: "rows_already_canonical",
        message: `Cannot apply — ${alreadyCanonical.length} of the displaced rows are already in canonical shape (canonicalized by a prior run). Refresh the page to re-plan.`,
      };
    }
  } else {
    // missing_lot stale guard: refuse if a lot OR closure already exists
    // for this tx id (probably created since planning by an unrelated
    // path — manual /portfolio/new flow, a parallel backfill, etc.).
    const existingLots = await db
      .select({ id: schema.holdingLots.id })
      .from(schema.holdingLots)
      .where(
        and(
          eq(schema.holdingLots.userId, userId),
          inArray(schema.holdingLots.openTxId, proposal.existingRowIds),
        ),
      );
    const existingClosures = await db
      .select({ id: schema.holdingLotClosures.id })
      .from(schema.holdingLotClosures)
      .where(
        and(
          eq(schema.holdingLotClosures.userId, userId),
          inArray(schema.holdingLotClosures.closeTxId, proposal.existingRowIds),
        ),
      );
    if (existingLots.length > 0 || existingClosures.length > 0) {
      return {
        ok: false,
        code: "lot_already_exists",
        message: `Cannot apply — a lot or closure already exists for this transaction (created since the backfill was planned). Refresh the page to re-plan.`,
      };
    }
  }

  await db.transaction(async (tx) => {
    // 1. Snapshot displaced rows
    const before = await tx
      .select()
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.userId, userId),
          inArray(schema.transactions.id, proposal.existingRowIds),
        ),
      );
    if (before.length > 0) {
      await tx.insert(schema.backfillAudit).values(
        before.map((row) => ({
          proposalId: proposal.id,
          txId: row.id,
          beforeJson: row,
        })),
      );
    }

    // 2. UPDATE-in-place
    for (const r of replacement) {
      const patch: Record<string, unknown> = { updatedAt: sql`NOW()` };
      if (r.amount !== undefined) patch.amount = r.amount;
      if (r.kind !== undefined) patch.kind = r.kind;
      if (r.tradeLinkId !== undefined) patch.tradeLinkId = r.tradeLinkId;
      if (r.linkId !== undefined) patch.linkId = r.linkId;
      // dividend_reinvestment fills its patch from the user's choice — the
      // proposal's `replacement[0]` only carries the txId; the holding
      // identifiers and kind come from the apply path so the user cannot
      // bypass the picker by manipulating the JSON.
      //
      // Phase 4b — variant branching:
      // - 'drip' (share reinvestment): the row IS shares acquired. Set
      //   portfolio_holding_id = chosen stock so the lot opens on that
      //   stock at costPerShare=amount/qty. qty preserved as share count.
      // - 'cash_dividend' (the typical stock case): the row is CASH that
      //   landed in the cash sleeve, attributed to the picked stock for
      //   reporting. Set portfolio_holding_id = matching cash sleeve in
      //   (account, currency), related_holding_id = chosen stock,
      //   kind='portfolio_income'. qty preserved as cash-units. Mirrors
      //   the shape produced by the IncomeExpenseForm + recordIncomeExpense
      //   path (see operations.ts).
      if (
        proposal.proposalKind === "dividend_reinvestment" &&
        proposal.chosenHoldingId != null
      ) {
        if (proposal.dividendVariant === "drip") {
          patch.portfolioHoldingId = proposal.chosenHoldingId;
          patch.kind = "dividend";
        } else {
          // cash_dividend — find the matching cash sleeve for this row's
          // (account, currency). Pulled inside the loop because we need
          // the displaced row's accountId + currency from `before`.
          const beforeRow = before.find((b) => b.id === r.txId);
          if (!beforeRow || beforeRow.accountId == null) {
            throw new Error(`cash_dividend apply: cannot locate displaced row ${r.txId} (account/currency unknown)`);
          }
          const sleeve = await tx
            .select({ id: schema.portfolioHoldings.id })
            .from(schema.portfolioHoldings)
            .where(
              and(
                eq(schema.portfolioHoldings.userId, userId),
                eq(schema.portfolioHoldings.accountId, beforeRow.accountId),
                eq(schema.portfolioHoldings.currency, beforeRow.currency),
                eq(schema.portfolioHoldings.isCash, true),
              ),
            )
            .limit(1);
          const sleeveId = sleeve[0]?.id;
          if (sleeveId == null) {
            // Surface as an unrecoverable apply failure — the caller
            // route catches it and surfaces in the UI.
            throw new Error(
              `cash_dividend apply: no cash sleeve in account ${beforeRow.accountId} for currency ${beforeRow.currency}. Create one in the account-detail page first.`,
            );
          }
          patch.portfolioHoldingId = sleeveId;
          patch.relatedHoldingId = proposal.chosenHoldingId;
          patch.kind = "portfolio_income";
        }
      }
      await tx
        .update(schema.transactions)
        .set(patch)
        .where(
          and(
            eq(schema.transactions.id, r.txId),
            eq(schema.transactions.userId, userId),
          ),
        );
      updatedTxIds.push(r.txId);
    }

    // 3. INSERT synthesized rows tagged 'backfill_synth'
    for (const s of synthesized) {
      const inserted = await tx
        .insert(schema.transactions)
        .values({
          userId,
          date: s.date,
          accountId: s.accountId,
          categoryId: s.categoryId,
          currency: s.currency,
          amount: s.amount,
          quantity: s.quantity ?? undefined,
          portfolioHoldingId: s.portfolioHoldingId,
          tradeLinkId: s.tradeLinkId,
          linkId: s.linkId,
          kind: s.kind,
          source: "backfill_synth",
        })
        .returning({ id: schema.transactions.id });
      const id = inserted[0]?.id;
      if (id != null) insertedTxIds.push(id);
    }

    // 4. Mark proposal applied (within the same tx so it's consistent)
    await tx
      .update(schema.backfillProposals)
      .set({ status: "applied", appliedAt: sql`NOW()` })
      .where(eq(schema.backfillProposals.id, proposal.id));
  });

  // 5. Replay applyLotEffectsForTx OUTSIDE the txn — buildLotContext reads via
  //    the default db handle and the live hook is designed for post-INSERT
  //    invocation. The hooks are self-transactional where they need to be.
  //
  // missing_lot proposals are special: there is no UPDATE-in-place (the
  // row is already correct, just the lot is missing). We replay the lot
  // hook on the existing row ids so the lot/closure gets created
  // retroactively. The replay below loads the row state fresh from the
  // DB, so kind / quantity / portfolio_holding_id reflect whatever is
  // currently stored.
  const ctx: LotContext = await buildLotContext(userId, dek);
  const allTouchedIds = [
    ...updatedTxIds,
    ...insertedTxIds,
    ...(proposal.proposalKind === "missing_lot" ? proposal.existingRowIds : []),
  ];
  if (allTouchedIds.length > 0) {
    const rows = await db
      .select({
        id: schema.transactions.id,
        userId: schema.transactions.userId,
        date: schema.transactions.date,
        amount: schema.transactions.amount,
        currency: schema.transactions.currency,
        enteredAmount: schema.transactions.enteredAmount,
        enteredCurrency: schema.transactions.enteredCurrency,
        quantity: schema.transactions.quantity,
        accountId: schema.transactions.accountId,
        categoryId: schema.transactions.categoryId,
        portfolioHoldingId: schema.transactions.portfolioHoldingId,
        tradeLinkId: schema.transactions.tradeLinkId,
        source: schema.transactions.source,
        kind: schema.transactions.kind,
      })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.userId, userId),
          inArray(schema.transactions.id, allTouchedIds),
        ),
      );
    for (const r of rows) {
      await applyLotEffectsForTx(
        {
          id: r.id,
          userId: r.userId,
          date: r.date,
          amount: r.amount ?? 0,
          currency: r.currency,
          enteredAmount: r.enteredAmount,
          enteredCurrency: r.enteredCurrency,
          quantity: r.quantity,
          accountId: r.accountId,
          categoryId: r.categoryId,
          portfolioHoldingId: r.portfolioHoldingId,
          tradeLinkId: r.tradeLinkId,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          source: (r.source ?? "manual") as any,
          kind: r.kind,
        },
        ctx,
      );
    }
  }

  invalidateUser(userId);

  return { ok: true, proposalId, updatedTxIds, insertedTxIds };
}

// ─── Kind override on refused orphan_stock_leg ───────────────────────
//
// User picks a chosenKind on the review page; PATCH stamps it on the
// proposal; applyProposal dispatches here. The pair-less branch
// (opening_balance / dividend / interest / portfolio_income /
// portfolio_expense) does UPDATE-in-place on the orphan row alone, then
// replays applyLotEffectsForTx so the lot engine picks up the new kind.
// The paired branch (buy / sell / in_kind_transfer / fx / brokerage)
// is NOT YET IMPLEMENTED — refuses with `paired_override_not_yet_implemented`
// and surfaces in the UI; tracked as a follow-up commit.

async function applyOrphanOverride(
  proposal: PersistedProposal,
  userId: string,
  dek: Buffer | null,
): Promise<ApplyResult | ApplyRefusal> {
  const chosenKind = proposal.chosenKind;
  if (chosenKind == null) {
    return {
      ok: false,
      code: "kind_override_missing",
      message: `Orphan-override apply requires chosen_kind to be set on the proposal.`,
    };
  }

  const isPairLess = OVERRIDE_PAIRLESS_KINDS.has(chosenKind);
  if (!isPairLess) {
    // Paired kinds (buy / sell / in_kind_transfer_* / fx_* / brokerage_*)
    // require the convertExisting*Pair helpers in operations.ts plus the
    // counterpart picker UI — not yet shipped (follow-up commit).
    return {
      ok: false,
      code: "paired_override_not_yet_implemented",
      message: `Paired override kinds (buy/sell/transfer/fx/brokerage) require the convertExisting*Pair helpers — not yet shipped. Use a pair-less kind (opening_balance / dividend / interest / portfolio_income / portfolio_expense) or fix manually in /transactions.`,
    };
  }

  // Refuse for portfolio_income/_expense without a chosen related holding
  // — mirror of the cash_dividend branch of dividend_reinvestment. Without
  // a related holding we'd lose the reporting attribution.
  if (
    (chosenKind === "portfolio_income" || chosenKind === "portfolio_expense") &&
    proposal.chosenRelatedHoldingId == null
  ) {
    return {
      ok: false,
      code: "related_holding_missing",
      message: `${chosenKind} override requires chosen_related_holding_id (the stock the income/expense relates to).`,
    };
  }

  // Stale-row guard — refuse if the orphan row has been canonicalized
  // since the proposal was emitted. Same predicate as the main apply
  // path's stale guard, but localised here because the override path
  // runs before the main guard.
  const PAIRLESS_DB_KINDS = new Set([
    "dividend",
    "interest",
    "portfolio_income",
    "portfolio_expense",
    "opening_balance",
  ]);
  const staleCheck = await db
    .select({
      id: schema.transactions.id,
      kind: schema.transactions.kind,
      tradeLinkId: schema.transactions.tradeLinkId,
      linkId: schema.transactions.linkId,
      amount: schema.transactions.amount,
      currency: schema.transactions.currency,
      accountId: schema.transactions.accountId,
      portfolioHoldingId: schema.transactions.portfolioHoldingId,
      quantity: schema.transactions.quantity,
    })
    .from(schema.transactions)
    .where(
      and(
        eq(schema.transactions.userId, userId),
        inArray(schema.transactions.id, proposal.existingRowIds),
      ),
    );
  const alreadyCanonical = staleCheck.filter(
    (r) =>
      r.kind != null &&
      r.kind !== "" &&
      (PAIRLESS_DB_KINDS.has(r.kind) ||
        r.tradeLinkId != null ||
        r.linkId != null),
  );
  if (alreadyCanonical.length > 0) {
    return {
      ok: false,
      code: "rows_already_canonical",
      message: `Cannot apply — ${alreadyCanonical.length} of the displaced rows are already in canonical shape (canonicalized by a prior run). Refresh the page to re-plan.`,
    };
  }

  const updatedTxIds: number[] = [];

  await db.transaction(async (tx) => {
    // 1. Snapshot to backfill_audit for Undo
    const before = await tx
      .select()
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.userId, userId),
          inArray(schema.transactions.id, proposal.existingRowIds),
        ),
      );
    if (before.length > 0) {
      await tx.insert(schema.backfillAudit).values(
        before.map((row) => ({
          proposalId: proposal.id,
          txId: row.id,
          beforeJson: row,
        })),
      );
    }

    // 2. UPDATE-in-place per row — pair-less branch
    for (const row of before) {
      const patch: Record<string, unknown> = {
        kind: chosenKind,
        updatedAt: sql`NOW()`,
      };

      // portfolio_income / portfolio_expense — swap onto the matching
      // cash sleeve and stamp the related holding. Mirror of the
      // cash_dividend branch of dividend_reinvestment.
      if (
        chosenKind === "portfolio_income" ||
        chosenKind === "portfolio_expense"
      ) {
        if (row.accountId == null) {
          throw new Error(
            `applyOrphanOverride: cannot locate orphan row ${row.id} account (NULL accountId)`,
          );
        }
        const sleeve = await tx
          .select({ id: schema.portfolioHoldings.id })
          .from(schema.portfolioHoldings)
          .where(
            and(
              eq(schema.portfolioHoldings.userId, userId),
              eq(schema.portfolioHoldings.accountId, row.accountId),
              eq(schema.portfolioHoldings.currency, row.currency),
              eq(schema.portfolioHoldings.isCash, true),
            ),
          )
          .limit(1);
        const sleeveId = sleeve[0]?.id;
        if (sleeveId == null) {
          throw new Error(
            `applyOrphanOverride: no cash sleeve in account ${row.accountId} for currency ${row.currency}. Create one in the account-detail page first.`,
          );
        }
        patch.portfolioHoldingId = sleeveId;
        patch.relatedHoldingId = proposal.chosenRelatedHoldingId;
      }
      // dividend / interest / opening_balance keep the row's existing
      // portfolio_holding_id (the orphan stock holding) — that's the
      // whole point of these overrides for DRIP / carry-in / direct
      // interest cases.

      await tx
        .update(schema.transactions)
        .set(patch)
        .where(
          and(
            eq(schema.transactions.id, row.id),
            eq(schema.transactions.userId, userId),
          ),
        );
      updatedTxIds.push(row.id);
    }

    // 3. Flip proposal status (consistent inside the tx)
    await tx
      .update(schema.backfillProposals)
      .set({ status: "applied", appliedAt: sql`NOW()` })
      .where(eq(schema.backfillProposals.id, proposal.id));
  });

  // 4. Replay lot effects on each updated row (outside the tx — hooks
  //    are designed for post-INSERT invocation, see apply.ts:377-440).
  const ctx: LotContext = await buildLotContext(userId, dek);
  if (updatedTxIds.length > 0) {
    const rows = await db
      .select({
        id: schema.transactions.id,
        userId: schema.transactions.userId,
        date: schema.transactions.date,
        amount: schema.transactions.amount,
        currency: schema.transactions.currency,
        enteredAmount: schema.transactions.enteredAmount,
        enteredCurrency: schema.transactions.enteredCurrency,
        quantity: schema.transactions.quantity,
        accountId: schema.transactions.accountId,
        categoryId: schema.transactions.categoryId,
        portfolioHoldingId: schema.transactions.portfolioHoldingId,
        tradeLinkId: schema.transactions.tradeLinkId,
        source: schema.transactions.source,
        kind: schema.transactions.kind,
      })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.userId, userId),
          inArray(schema.transactions.id, updatedTxIds),
        ),
      );
    for (const r of rows) {
      await applyLotEffectsForTx(
        {
          id: r.id,
          userId: r.userId,
          date: r.date,
          amount: r.amount ?? 0,
          currency: r.currency,
          enteredAmount: r.enteredAmount,
          enteredCurrency: r.enteredCurrency,
          quantity: r.quantity,
          accountId: r.accountId,
          categoryId: r.categoryId,
          portfolioHoldingId: r.portfolioHoldingId,
          tradeLinkId: r.tradeLinkId,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          source: (r.source ?? "manual") as any,
          kind: r.kind,
        },
        ctx,
      );
    }
  }

  invalidateUser(userId);

  return {
    ok: true,
    proposalId: proposal.id,
    updatedTxIds,
    insertedTxIds: [],
  };
}

// ─── Undo ─────────────────────────────────────────────────────────────

export interface UndoResult {
  ok: true;
  proposalId: number;
  restoredTxIds: number[];
  deletedTxIds: number[];
}

export async function undoProposal(
  proposalId: number,
  userId: string,
): Promise<UndoResult | ApplyRefusal> {
  const proposal = await loadProposal(proposalId, userId);
  if (!proposal) {
    return { ok: false, code: "not_found", message: `Proposal ${proposalId} not found` };
  }
  if (proposal.status !== "applied") {
    return { ok: false, code: "wrong_status", message: `Proposal ${proposalId} status is '${proposal.status}', not 'applied'` };
  }

  // Check for child proposals (proposals that depend on this one) that have
  // already been applied — undoing this would break their lot chain.
  const dependentApplied = await db
    .select({
      id: schema.backfillProposals.id,
    })
    .from(schema.backfillProposals)
    .where(
      and(
        eq(schema.backfillProposals.userId, userId),
        eq(schema.backfillProposals.status, "applied"),
        sql`${proposal.id} = ANY(${schema.backfillProposals.dependsOnProposalIds})`,
      ),
    );
  if (dependentApplied.length > 0) {
    return {
      ok: false,
      code: "dependents_applied",
      message: `Undo blocked by dependent proposals already applied: [${dependentApplied.map((d) => d.id).join(", ")}]. Undo them first.`,
      blockingProposalIds: dependentApplied.map((d) => d.id),
    };
  }

  // Find all affected tx ids — existing rows that were UPDATEd in place +
  // synthesized rows whose snapshot we never took (they were net-new). We
  // identify the synthesized rows by querying for `source='backfill_synth'`
  // rows linked to this proposal's tradeLinkId. Simpler approach: read
  // tradeLinkId from any of the existing rows' current state and walk siblings.
  const affectedIds = new Set<number>(proposal.existingRowIds);
  // Pick up any sibling rows sharing trade_link_id (synthesized cash legs)
  const sample = await db
    .select({ tradeLinkId: schema.transactions.tradeLinkId, linkId: schema.transactions.linkId })
    .from(schema.transactions)
    .where(
      and(
        eq(schema.transactions.userId, userId),
        inArray(schema.transactions.id, proposal.existingRowIds),
      ),
    );
  for (const s of sample) {
    if (s.tradeLinkId) {
      const sib = await db
        .select({ id: schema.transactions.id, source: schema.transactions.source })
        .from(schema.transactions)
        .where(
          and(
            eq(schema.transactions.userId, userId),
            eq(schema.transactions.tradeLinkId, s.tradeLinkId),
          ),
        );
      for (const r of sib) affectedIds.add(r.id);
    }
  }

  // Live-engine guard: any of these tx ids open lots that have downstream closures?
  const blockingClosureTxIds: number[] = [];
  for (const txId of affectedIds) {
    const guard = await canEditPortfolioRow(userId, txId);
    if (!guard.allowed && guard.blockingClosureTxIds) {
      for (const b of guard.blockingClosureTxIds) {
        if (!affectedIds.has(b)) blockingClosureTxIds.push(b);
      }
    }
  }
  if (blockingClosureTxIds.length > 0) {
    return {
      ok: false,
      code: "portfolio_edit_blocked",
      message: `Cannot undo — this proposal opens lots that have been sold or transferred out. Delete the ${blockingClosureTxIds.length} dependent transaction(s) first.`,
      blockingClosureTxIds,
    };
  }

  const restoredTxIds: number[] = [];
  const deletedTxIds: number[] = [];

  // Reverse lots BEFORE the txn restores rows — the hook needs the current
  // (post-apply) tx state to find what to undo.
  for (const txId of affectedIds) {
    await reverseLotsForDeleteHook(userId, txId);
  }

  await db.transaction(async (tx) => {
    // 1. Restore existing rows from snapshot
    const snapshots = await tx
      .select()
      .from(schema.backfillAudit)
      .where(eq(schema.backfillAudit.proposalId, proposal.id));

    for (const snap of snapshots) {
      const before = snap.beforeJson as Record<string, unknown>;
      const restorePatch: Record<string, unknown> = { updatedAt: sql`NOW()` };
      // Restore the columns the apply path may have changed.
      if ("amount" in before) restorePatch.amount = before.amount;
      if ("kind" in before) restorePatch.kind = before.kind ?? null;
      if ("tradeLinkId" in before) restorePatch.tradeLinkId = before.tradeLinkId ?? null;
      if ("trade_link_id" in before) restorePatch.tradeLinkId = before.trade_link_id ?? null;
      if ("linkId" in before) restorePatch.linkId = before.linkId ?? null;
      if ("link_id" in before) restorePatch.linkId = before.link_id ?? null;
      await tx
        .update(schema.transactions)
        .set(restorePatch)
        .where(
          and(
            eq(schema.transactions.id, snap.txId),
            eq(schema.transactions.userId, userId),
          ),
        );
      restoredTxIds.push(snap.txId);
    }

    // 2. DELETE synthesized rows — anything in affectedIds whose source is 'backfill_synth'
    const synthRows = await tx
      .select({ id: schema.transactions.id })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.userId, userId),
          eq(schema.transactions.source, "backfill_synth"),
          inArray(schema.transactions.id, Array.from(affectedIds)),
        ),
      );
    for (const r of synthRows) {
      await tx
        .delete(schema.transactions)
        .where(
          and(
            eq(schema.transactions.id, r.id),
            eq(schema.transactions.userId, userId),
          ),
        );
      deletedTxIds.push(r.id);
    }

    // 3. Mark proposal undone
    await tx
      .update(schema.backfillProposals)
      .set({ status: "undone" })
      .where(eq(schema.backfillProposals.id, proposal.id));
  });

  invalidateUser(userId);
  return { ok: true, proposalId, restoredTxIds, deletedTxIds };
}

// ─── Loader ──────────────────────────────────────────────────────────

// ─── Snapshot loader (DB → LedgerSnapshot for the pure planner) ──────

/**
 * Read everything the pure `planBackfill()` needs from the DB. Pre-filters
 * by scope when possible (account ids, date range) so the planner doesn't
 * grind through the whole ledger for a narrow run.
 *
 * `dek` is used to decrypt display names for the proposal summaries. Pass
 * `null` if running in a context without one (CLI operator, stdio MCP); the
 * planner doesn't depend on display names for correctness.
 */
export async function loadLedgerSnapshot(
  userId: string,
  dek: Buffer | null,
  scope: { accountIds?: number[]; dateFrom?: string; dateTo?: string },
): Promise<LedgerSnapshot> {
  // Holdings — every cash sleeve + non-cash holding belonging to user.
  const holdingsRaw = await db
    .select({
      id: schema.portfolioHoldings.id,
      currency: schema.portfolioHoldings.currency,
      isCash: schema.portfolioHoldings.isCash,
      nameCt: schema.portfolioHoldings.nameCt,
      accountId: schema.holdingAccounts.accountId,
    })
    .from(schema.portfolioHoldings)
    .leftJoin(
      schema.holdingAccounts,
      and(
        eq(schema.holdingAccounts.holdingId, schema.portfolioHoldings.id),
        eq(schema.holdingAccounts.userId, userId),
      ),
    )
    .where(eq(schema.portfolioHoldings.userId, userId));

  const holdings: SnapshotHolding[] = holdingsRaw
    .filter((h): h is typeof h & { accountId: number } => h.accountId != null)
    .map((h) => ({
      id: h.id,
      accountId: h.accountId,
      currency: h.currency,
      isCash: Boolean(h.isCash),
      displayName: decryptName(h.nameCt, dek, null) ?? null,
    }));

  // Accounts
  const accountsRaw = await db
    .select({
      id: schema.accounts.id,
      currency: schema.accounts.currency,
      isInvestment: schema.accounts.isInvestment,
      nameCt: schema.accounts.nameCt,
    })
    .from(schema.accounts)
    .where(eq(schema.accounts.userId, userId));

  const accounts: SnapshotAccount[] = accountsRaw.map((a) => ({
    id: a.id,
    currency: a.currency,
    isInvestment: Boolean(a.isInvestment),
    displayName: decryptName(a.nameCt, dek, null) ?? null,
  }));

  // Transactions — filtered to investment accounts only (backfill V1 scope)
  const investmentAccountIds = accounts.filter((a) => a.isInvestment).map((a) => a.id);
  const allowedAccountIds = scope.accountIds && scope.accountIds.length > 0
    ? scope.accountIds.filter((id) => investmentAccountIds.includes(id))
    : investmentAccountIds;

  if (allowedAccountIds.length === 0) {
    return {
      userId,
      txs: [],
      holdings,
      accounts,
      dividendsCategoryId: null,
      lotsByOpenTxId: new Set(),
      closuresByCloseTxId: new Set(),
    };
  }

  const txsRaw = await db
    .select({
      id: schema.transactions.id,
      date: schema.transactions.date,
      accountId: schema.transactions.accountId,
      categoryId: schema.transactions.categoryId,
      currency: schema.transactions.currency,
      amount: schema.transactions.amount,
      quantity: schema.transactions.quantity,
      portfolioHoldingId: schema.transactions.portfolioHoldingId,
      tradeLinkId: schema.transactions.tradeLinkId,
      linkId: schema.transactions.linkId,
      source: schema.transactions.source,
      kind: schema.transactions.kind,
    })
    .from(schema.transactions)
    .where(
      and(
        eq(schema.transactions.userId, userId),
        inArray(schema.transactions.accountId, allowedAccountIds),
        scope.dateFrom ? sql`${schema.transactions.date} >= ${scope.dateFrom}` : sql`TRUE`,
        scope.dateTo ? sql`${schema.transactions.date} <= ${scope.dateTo}` : sql`TRUE`,
      ),
    );

  const txs: SnapshotTx[] = txsRaw.map((t) => ({
    id: t.id,
    userId,
    date: t.date,
    accountId: t.accountId,
    categoryId: t.categoryId,
    currency: t.currency,
    amount: t.amount ?? 0,
    quantity: t.quantity,
    portfolioHoldingId: t.portfolioHoldingId,
    tradeLinkId: t.tradeLinkId,
    linkId: t.linkId,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    source: (t.source ?? "manual") as any,
    kind: t.kind,
  }));

  const dividendsCategoryId = await resolveDividendsCategoryId(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db as any,
    userId,
    dek,
  );

  // Phase 3 (missing-lot detection): load lots + closures keyed by tx id
  // so Pass 0 can detect canonical rows whose lot operations never ran.
  // Scoped to the same allowedAccountIds — a lot in a different account
  // isn't relevant.
  const lotsRaw = await db
    .select({ openTxId: schema.holdingLots.openTxId })
    .from(schema.holdingLots)
    .where(
      and(
        eq(schema.holdingLots.userId, userId),
        inArray(schema.holdingLots.accountId, allowedAccountIds),
      ),
    );
  const lotsByOpenTxId = new Set<number>();
  for (const l of lotsRaw) {
    if (l.openTxId != null) lotsByOpenTxId.add(l.openTxId);
  }

  const closuresRaw = await db
    .select({ closeTxId: schema.holdingLotClosures.closeTxId })
    .from(schema.holdingLotClosures)
    .where(eq(schema.holdingLotClosures.userId, userId));
  const closuresByCloseTxId = new Set<number>();
  for (const c of closuresRaw) {
    if (c.closeTxId != null) closuresByCloseTxId.add(c.closeTxId);
  }

  return {
    userId,
    txs,
    holdings,
    accounts,
    dividendsCategoryId,
    lotsByOpenTxId,
    closuresByCloseTxId,
  };
}

async function loadProposal(
  proposalId: number,
  userId: string,
): Promise<PersistedProposal | null> {
  const rows = await db
    .select()
    .from(schema.backfillProposals)
    .where(
      and(
        eq(schema.backfillProposals.id, proposalId),
        eq(schema.backfillProposals.userId, userId),
      ),
    );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    runId: row.runId,
    userId: row.userId,
    proposalKind: row.proposalKind as ProposalKind,
    confidence: row.confidence as Confidence,
    refusalReason: row.refusalReason,
    summary: row.summary,
    existingRowIds: row.existingRowIds ?? [],
    replacementRowsJson: row.replacementRowsJson,
    synthesizedRowsJson: row.synthesizedRowsJson,
    dependsOnProposalIds: row.dependsOnProposalIds ?? [],
    variantChoice: row.variantChoice,
    chosenHoldingId: row.chosenHoldingId,
    dividendVariant: row.dividendVariant as "cash_dividend" | "drip" | null,
    chosenKind: (row.chosenKind ?? null) as OverrideKind | null,
    chosenCounterpartTxId: row.chosenCounterpartTxId ?? null,
    chosenCounterpartMode:
      (row.chosenCounterpartMode ?? null) as
        | "link_existing"
        | "synth_new"
        | null,
    chosenRelatedHoldingId: row.chosenRelatedHoldingId ?? null,
    status: row.status,
  };
}
