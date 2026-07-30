/**
 * Shared error → HTTP response mapping for /api/portfolio/operations/* routes.
 *
 * Each route delegates to the corresponding helper in
 * src/lib/portfolio/operations.ts; this file maps the domain errors those
 * helpers throw into structured 400 responses.
 */

import { NextResponse } from "next/server";
import { withDbTransaction } from "@/db";
import {
  CashSleeveNotFoundError,
  CurrencyMismatchError,
  HoldingNotFoundError,
  InvalidLinkPairError,
} from "@/lib/portfolio/operations";
import {
  deleteTransactionsCascade,
  planTransactionDelete,
} from "@/lib/transactions/delete-cascade";

export function mapOperationError(err: unknown): NextResponse | null {
  if (err instanceof CashSleeveNotFoundError) {
    return NextResponse.json(
      {
        error: err.message,
        code: err.code,
        accountId: err.accountId,
        currency: err.currency,
      },
      { status: 400 },
    );
  }
  if (err instanceof CurrencyMismatchError) {
    return NextResponse.json(
      {
        error: err.message,
        code: err.code,
        expected: err.expected,
        got: err.got,
      },
      { status: 400 },
    );
  }
  if (err instanceof HoldingNotFoundError) {
    return NextResponse.json(
      { error: err.message, code: err.code, holdingId: err.holdingId },
      { status: 404 },
    );
  }
  if (err instanceof InvalidLinkPairError) {
    return NextResponse.json(
      { error: err.message, code: "invalid_link_pair" },
      { status: 400 },
    );
  }
  if (err instanceof ReplaceRefusedError) {
    return NextResponse.json(
      { error: err.message, code: err.code },
      { status: 409 },
    );
  }
  return null;
}

/**
 * Edit-as-replace for the operation POST routes.
 *
 * When the client passes `editId` in the body of a POST to
 * `/api/portfolio/operations/<op>`, we treat it as "replace the existing pair
 * with new values": cascade-delete the old pair, then record the new one.
 *
 * ── THE DATA-LOSS BUG THIS FIXES (2026-07-30) ──────────────────────────────
 * The old shape was a standalone `cascadeDeleteForReplace(userId, editId)`
 * that DELETED AND COMMITTED, then returned so the route could call
 * `recordBuy`/`recordSell`/… as a separate step. Every ordinary validation
 * failure in that second step — `CashSleeveNotFoundError` (editing a trade
 * into an account with no sleeve in that currency), `CurrencyMismatchError`,
 * an FX 409 — therefore PERMANENTLY DESTROYED the user's original trade while
 * returning a 400 that read like nothing had happened.
 *
 * `replacePortfolioOperation` folds both halves into ONE ambient transaction
 * (`withDbTransaction`), so a throw from `record()` rolls the delete back and
 * the original pair is still there. The route surfaces the same 400 it always
 * did; the difference is the ledger is unchanged.
 *
 * Reordering alone (validate before deleting) would NOT have been enough — a
 * dropped connection between the delete and the insert loses the pair just as
 * completely.
 *
 * Steps:
 *   1. Verify the editId tx belongs to this user (404).
 *   2. Edit-guard every row in the link closure — refuse 409 when a row opens
 *      a lot with downstream closures we'd orphan.
 *   3. Delete the closure (lot effects reversed first) and record the
 *      replacement, atomically.
 */
export async function replacePortfolioOperation<T>(
  userId: string,
  editId: number,
  record: () => Promise<T>,
): Promise<{ ok: true; result: T } | { ok: false; response: NextResponse }> {
  // Plan OUTSIDE the transaction so refusals (404 / 409) never open one.
  const plan = await planTransactionDelete(userId, [editId]);
  if (plan.ids.length === 0) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: `Transaction ${editId} not found` },
        { status: 404 },
      ),
    };
  }
  if (plan.blockingClosureTxIds.length > 0) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error:
            `Cannot edit — this transaction opens a lot that has been sold or transferred out. ` +
            `Delete the ${plan.blockingClosureTxIds.length} dependent transaction(s) first.`,
          code: "portfolio_edit_blocked",
          blockingClosureTxIds: plan.blockingClosureTxIds,
        },
        { status: 409 },
      ),
    };
  }

  const result = await withDbTransaction(async () => {
    const outcome = await deleteTransactionsCascade(userId, [editId], { plan });
    if (!outcome.ok) {
      // Re-checked inside the transaction; a refusal here aborts it.
      throw new ReplaceRefusedError(outcome.message);
    }
    return record();
  });
  return { ok: true, result };
}

/** Internal — a plan/execute disagreement, surfaced as a 409 by the caller. */
export class ReplaceRefusedError extends Error {
  readonly code = "portfolio_edit_blocked" as const;
}

