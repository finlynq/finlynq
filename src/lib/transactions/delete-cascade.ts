/**
 * THE transaction-delete chokepoint (2026-07-30).
 *
 * Deleting a `transactions` row safely is not "run a DELETE". It is five
 * ordered steps, and every one of them has bitten us:
 *
 *   1. EXPAND the delete set to the full link-sibling closure
 *      (`expandLinkSiblings` — trade_link_id / link_id / swap_link_id).
 *      Deleting one leg of a pair leaves money "appearing" in one account.
 *   2. GUARD each row through `canEditPortfolioRow`: a buy whose lot has
 *      already been sold can't just vanish, or the sell's closures point at
 *      nothing. Either refuse (409-shaped) or reallocate on explicit confirm.
 *   3. REVERSE lot effects BEFORE the rows are gone (`reverseLotsForDeleteHook`
 *      looks rows up by `close_tx_id` / `open_tx_id`).
 *   4. DELETE the whole set in ONE statement so a half-deleted pair is not a
 *      reachable state.
 *   5. STAMP the snapshot dirty markers so net-worth history re-materializes,
 *      and invalidate the per-user MCP tx cache.
 *
 * The single-row web `DELETE /api/transactions` did all five. `POST
 * /api/transactions/bulk` (delete), MCP `manage_transactions(op:delete)`, MCP
 * `execute_bulk_delete` and stdio `delete_transaction` each did a raw
 * `DELETE ... WHERE id IN (…)` and none of the rest — the full-app review's
 * Theme 1. All five now call in here.
 *
 * ── Executor ────────────────────────────────────────────────────────────────
 * Like the delete-blocker helpers, the expand/guard/delete queries take an
 * `{execute}` executor and are written as raw `sql` templates, so the app's
 * Drizzle proxy AND the MCP tool context's execute-only `DbLike` both satisfy
 * them (in production they are literally the same object — `registerPgTools`
 * is handed `@/db`). The composed lot + snapshot helpers stay `@/db`-bound;
 * the stdio server therefore registers that adapter at startup
 * (mcp-server/index.ts) so `delete_transaction` can reach them too.
 *
 * ── Atomicity ───────────────────────────────────────────────────────────────
 * The execute phase runs inside `withDbTransaction`, so lot reversal + the
 * delete + the dirty stamps commit or roll back together (see the ambient
 * transaction scope in `src/db/index.ts` for why that is an AsyncLocalStorage
 * scope rather than a threaded `tx` handle). Even with the transaction, the
 * ORDER above is load-bearing — step 3 reads rows step 4 removes.
 */

import { db as defaultDb, withDbTransaction } from "@/db";
import { sql } from "drizzle-orm";
import { normalizeDbRows } from "@/lib/db-utils";
import { expandLinkSiblings } from "./link-siblings";
import {
  applyLotEffectsForTx,
  buildLotContext,
  reverseLotsForDeleteHook,
} from "@/lib/portfolio/lots/write-hooks";
import { canEditPortfolioRow } from "@/lib/portfolio/operations";
import { markSnapshotsDirty } from "@/lib/portfolio/snapshots/dirty";
import { markCashSnapshotsDirty } from "@/lib/portfolio/snapshots/cash-dirty";
import { invalidateUser as invalidateUserTxCache } from "@/lib/mcp/user-tx-cache";
import type { TransactionSource } from "@/lib/tx-source";
import type { TxRowForLots } from "@/lib/portfolio/lots/types";

/**
 * Minimal structural type satisfied by the app's Drizzle proxy (`@/db`), a
 * Drizzle transaction handle, and the MCP tool context's `DbLike`.
 */
export type Executor = { execute: (query: ReturnType<typeof sql>) => Promise<unknown> };

/** `ANY(ARRAY[...]::int[])` list — parameterized, never a hand-built CSV. */
function intList(ids: number[]) {
  return sql.join(ids.map((n) => sql`${Number(n)}`), sql`, `);
}

/** What a delete WOULD do — computed before anything is written. */
export interface DeleteCascadePlan {
  /** Ids the caller asked for (deduped, owner-verified subset in `ids`). */
  seedIds: number[];
  /** The full delete set: seeds + every link sibling. */
  ids: number[];
  /** `ids` minus `seedIds` — what the cascade ADDS. Disclose this in previews. */
  siblingIds: number[];
  /** True when the cascade pulled in rows the caller didn't name. */
  cascaded: boolean;
  /** Seed ids that don't exist / aren't owned by `userId`. */
  missingIds: number[];
  /**
   * Rows OUTSIDE the delete set whose lot closures depend on rows inside it.
   * Non-empty ⇒ refuse unless the caller passes `confirmReallocation`.
   */
  blockingClosureTxIds: number[];
  /** Earliest date among deleted investment rows (per-user dirty marker). */
  snapshotDirtyFrom: string | null;
  /** Earliest deleted date per cash account (per-account dirty marker). */
  cashDirty: Array<{ accountId: number; date: string }>;
}

export type DeleteCascadeOutcome =
  | {
      ok: true;
      deletedIds: number[];
      cascaded: boolean;
      /** Dependent closures that were re-FIFO'd (FINLYNQ-176 confirm path). */
      reallocated: number[];
    }
  | { ok: false; reason: "not_found"; missingIds: number[]; message: string }
  | {
      ok: false;
      reason: "portfolio_edit_blocked";
      blockingClosureTxIds: number[];
      message: string;
    };

/** Shared refusal wording so every surface says the same thing. */
export function portfolioEditBlockedMessage(count: number): string {
  return (
    `This transaction opens one or more lots that have been sold or transferred out. ` +
    `Delete the ${count} dependent transaction(s) first, then retry.`
  );
}

/**
 * Steps 1 + 2 (plus the pre-delete snapshot-date capture), with nothing
 * written. Callers that need a two-step confirmation (MCP preview/execute)
 * run this first so the disclosed row set is the set that will actually go.
 */
export async function planTransactionDelete(
  userId: string,
  seedIds: number[],
  executor: Executor = defaultDb,
): Promise<DeleteCascadePlan> {
  const seeds = Array.from(new Set(seedIds.filter((n) => Number.isInteger(n))));
  const empty: DeleteCascadePlan = {
    seedIds: seeds,
    ids: [],
    siblingIds: [],
    cascaded: false,
    missingIds: seeds,
    blockingClosureTxIds: [],
    snapshotDirtyFrom: null,
    cashDirty: [],
  };
  if (seeds.length === 0) return { ...empty, missingIds: [] };

  // Owner scope — a seed we can't see is `missing`, never silently dropped.
  const owned = normalizeDbRows<{ id: number }>(
    await executor.execute(sql`
      SELECT id FROM transactions
       WHERE user_id = ${userId} AND id = ANY(ARRAY[${intList(seeds)}]::int[])
    `),
  );
  const ownedIds = owned.map((r) => Number(r.id));
  const ownedSet = new Set(ownedIds);
  const missingIds = seeds.filter((id) => !ownedSet.has(id));
  if (ownedIds.length === 0) return { ...empty, missingIds };

  const ids = await expandLinkSiblings(userId, ownedIds, executor);
  const idSet = new Set(ids);
  const siblingIds = ids.filter((id) => !ownedSet.has(id));

  // Capture the affected dates BEFORE the rows disappear.
  let snapshotDirtyFrom: string | null = null;
  const cashDirtyByAccount = new Map<number, string>();
  try {
    const rows = normalizeDbRows<{
      date: string;
      account_id: number | null;
      portfolio_holding_id: number | null;
    }>(
      await executor.execute(sql`
        SELECT date, account_id, portfolio_holding_id FROM transactions
         WHERE user_id = ${userId} AND id = ANY(ARRAY[${intList(ids)}]::int[])
      `),
    );
    for (const r of rows) {
      const date = String(r.date).slice(0, 10);
      if (r.portfolio_holding_id != null) {
        if (snapshotDirtyFrom == null || date < snapshotDirtyFrom) {
          snapshotDirtyFrom = date;
        }
      } else if (r.account_id != null) {
        const accountId = Number(r.account_id);
        const cur = cashDirtyByAccount.get(accountId);
        if (cur == null || date < cur) cashDirtyByAccount.set(accountId, date);
      }
    }
  } catch {
    /* best-effort — a marker we couldn't compute must not block the delete */
  }

  // Portfolio edit-guard over the WHOLE set. Ids already being deleted are
  // not "blocking" — the user is removing them too.
  const blockingSet = new Set<number>();
  for (const txId of ids) {
    const guard = await canEditPortfolioRow(userId, txId, executor);
    if (!guard.allowed && guard.blockingClosureTxIds) {
      for (const b of guard.blockingClosureTxIds) {
        if (!idSet.has(b)) blockingSet.add(b);
      }
    }
  }

  return {
    seedIds: seeds,
    ids,
    siblingIds,
    cascaded: ids.length > ownedIds.length,
    missingIds,
    blockingClosureTxIds: Array.from(blockingSet),
    snapshotDirtyFrom,
    cashDirty: Array.from(cashDirtyByAccount, ([accountId, date]) => ({
      accountId,
      date,
    })),
  };
}

export interface DeleteCascadeOptions {
  /**
   * FINLYNQ-176 — opt into warn-and-reallocate instead of the
   * `portfolio_edit_blocked` refusal. The dependent closures are reversed,
   * the rows deleted, then the dependents re-closed FIFO against the
   * remaining inventory (STRICT — any failure throws and rolls back).
   */
  confirmReallocation?: boolean;
  /** Reuse a plan already computed (MCP preview → execute). */
  plan?: DeleteCascadePlan;
  /**
   * Refuse outright when any seed id is missing/unowned. The web single-row
   * route wants a 404; bulk paths tolerate a partial set.
   */
  requireAllSeeds?: boolean;
  /** Query executor — defaults to the app's `@/db` proxy. */
  executor?: Executor;
}

/**
 * The chokepoint. Expand → guard → reverse lots → delete → stamp dirty →
 * invalidate. Every delete surface calls exactly this.
 */
export async function deleteTransactionsCascade(
  userId: string,
  seedIds: number[],
  opts: DeleteCascadeOptions = {},
): Promise<DeleteCascadeOutcome> {
  const executor = opts.executor ?? defaultDb;
  const plan = opts.plan ?? (await planTransactionDelete(userId, seedIds, executor));

  if (plan.ids.length === 0 || (opts.requireAllSeeds && plan.missingIds.length > 0)) {
    return {
      ok: false,
      reason: "not_found",
      missingIds: plan.missingIds,
      message:
        plan.missingIds.length === 1
          ? `Transaction #${plan.missingIds[0]} not found`
          : `Transaction(s) not found: ${plan.missingIds.join(", ")}`,
    };
  }

  if (plan.blockingClosureTxIds.length > 0 && !opts.confirmReallocation) {
    return {
      ok: false,
      reason: "portfolio_edit_blocked",
      blockingClosureTxIds: plan.blockingClosureTxIds,
      message: portfolioEditBlockedMessage(plan.blockingClosureTxIds.length),
    };
  }

  const reallocated = plan.blockingClosureTxIds;

  await withDbTransaction(async () => {
    if (reallocated.length > 0) {
      // FINLYNQ-176 reallocation path. Reverse the dependent closures FIRST so
      // they release the lots the deleted rows opened, delete, then re-close
      // the dependents against the post-delete inventory. STRICT mode makes
      // the lot hooks throw instead of soft-failing, so the whole block rolls
      // back rather than half-applying.
      const { __setLotWriteHookStrictMode } = await import(
        "@/lib/portfolio/lots/write-hooks"
      );
      __setLotWriteHookStrictMode(true);
      try {
        for (const depId of reallocated) {
          await reverseLotsForDeleteHook(userId, depId);
        }
        for (const txId of plan.ids) {
          await reverseLotsForDeleteHook(userId, txId);
        }
        await deleteRows(userId, plan.ids, executor);
        await reCloseDependents(userId, reallocated, executor);
      } finally {
        __setLotWriteHookStrictMode(false);
      }
    } else {
      // Standard path. Reverse lots BEFORE the rows go — the hook looks them
      // up by open_tx_id / close_tx_id. ON DELETE CASCADE on
      // holding_lots.open_tx_id catches any stray as defense-in-depth.
      for (const txId of plan.ids) {
        await reverseLotsForDeleteHook(userId, txId);
      }
      await deleteRows(userId, plan.ids, executor);
    }

    if (plan.snapshotDirtyFrom) {
      await markSnapshotsDirty(userId, plan.snapshotDirtyFrom);
    }
    for (const { accountId, date } of plan.cashDirty) {
      await markCashSnapshotsDirty(userId, accountId, date);
    }
  });

  // In-memory cache — only meaningful once the transaction has committed.
  invalidateUserTxCache(userId);

  return {
    ok: true,
    deletedIds: plan.ids,
    cascaded: plan.cascaded,
    reallocated,
  };
}

/**
 * ONE statement for the whole delete set. A per-id loop is what made a
 * half-deleted transfer pair reachable in the first place.
 */
async function deleteRows(userId: string, ids: number[], executor: Executor): Promise<void> {
  if (ids.length === 0) return;
  await executor.execute(sql`
    DELETE FROM transactions
     WHERE user_id = ${userId} AND id = ANY(ARRAY[${intList(ids)}]::int[])
  `);
}

/** Re-close the still-existing dependent rows against post-delete inventory. */
async function reCloseDependents(
  userId: string,
  depIds: number[],
  executor: Executor,
): Promise<void> {
  if (depIds.length === 0) return;
  const ctx = await buildLotContext(userId, null);
  const depRows = normalizeDbRows<Record<string, unknown>>(
    await executor.execute(sql`
      SELECT id, user_id, date, amount, currency, entered_amount, entered_currency,
             quantity, account_id, category_id, portfolio_holding_id, trade_link_id,
             source, kind
        FROM transactions
       WHERE user_id = ${userId} AND id = ANY(ARRAY[${intList(depIds)}]::int[])
    `),
  );
  depRows.sort((a, b) => {
    const d = String(a.date).localeCompare(String(b.date));
    return d !== 0 ? d : Number(a.id) - Number(b.id);
  });
  for (const r of depRows) {
    if (r.portfolio_holding_id == null || r.quantity == null) continue;
    await applyLotEffectsForTx(
      {
        id: Number(r.id),
        userId: String(r.user_id),
        date: String(r.date).slice(0, 10),
        amount: Number(r.amount ?? 0),
        currency: (r.currency as string) ?? "USD",
        enteredAmount: r.entered_amount == null ? null : Number(r.entered_amount),
        enteredCurrency: (r.entered_currency as string | null) ?? null,
        quantity: Number(r.quantity),
        accountId: r.account_id == null ? null : Number(r.account_id),
        categoryId: r.category_id == null ? null : Number(r.category_id),
        portfolioHoldingId: Number(r.portfolio_holding_id),
        tradeLinkId: (r.trade_link_id as string | null) ?? null,
        source: ((r.source as string) ?? "manual") as TransactionSource,
        kind: (r.kind as string | null) ?? null,
      } as TxRowForLots,
      ctx,
    );
  }
}
