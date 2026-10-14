/**
 * POST /api/portfolio/holdings/[holdingId]/lots/reassign — FINLYNQ-178
 *
 * Manual lot reassignment. Fast-follow to FINLYNQ-176's read-only inspector:
 * lets the user re-point a SINGLE closure (one sell tx) onto lots of their
 * choosing, rather than the automatic FIFO allocation.
 *
 * Body: { closeTxId, perLotQty: [{ lotId, qty }], preview? }
 *   - preview:true  → dry-run; returns { preview } and writes NOTHING.
 *   - preview:false → STRICT commit; reverses ONLY this close-tx's closures
 *                     and re-closes it against the chosen lots (overflow →
 *                     short), all-or-nothing. Returns { preview, committed:true }.
 *
 * STRICT validation (write NOTHING on failure):
 *   - Σ perLotQty.qty must equal the whole sale → 400 qty_mismatch. A sale
 *     that sold more than was held includes the short part, entered as
 *     lotId 0, so saving opens the short again.
 *   - a short the sale opened that a later buy already closed → 400
 *     short_already_covered (re-matching would erase that closing).
 *   - every named lot must belong to the same (holding, account) as the
 *     close-tx (same-account-only) → 400 lot_not_in_scope.
 *   - the closure must be a plain SELL → 400 not_reassignable.
 *   - a sale can only use shares bought on or before its date → 400
 *     lot_bought_after_sale. A later lot the sale ALREADY uses (trades
 *     entered out of date order) may keep up to what it takes today.
 *
 * Only the reassigned closure's realized gain restates; sibling closures stay
 * byte-identical. Position qty stays live SUM(quantity) — only lot/closure
 * rows move; no `transactions` row is touched.
 *
 * Auth: requireEncryption — the commit resolves the Dividends category for
 * the lot context (DEK-bearing), mirroring lot-replan-preview.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { validateBody, safeErrorMessage, logApiError } from "@/lib/validate";
import {
  reassignClosureLots,
  type ReassignError,
} from "@/lib/portfolio/lots/write-hooks";
import { reassignErrorMessage } from "@/lib/portfolio/lots/reassign-errors";

const bodySchema = z.object({
  closeTxId: z.number().int().positive(),
  perLotQty: z
    .array(
      z.object({
        // 0 (SHORT_LOT_ID) = the part of the sale sold short (no lot).
        lotId: z.number().int().min(0),
        qty: z.number().positive(),
      }),
    )
    .min(1),
  /** When true (default), dry-run preview only. false → STRICT commit. */
  preview: z.boolean().optional(),
});

/** Map the typed lib error to an HTTP status + message. All are 4xx
 *  (the request is malformed / the targeted state doesn't allow it); none
 *  writes any rows. */
function mapReassignError(err: ReassignError): NextResponse {
  switch (err.code) {
    case "close_tx_not_found":
      return NextResponse.json(
        { error: reassignErrorMessage(err), code: err.code },
        { status: 404 },
      );
    case "no_closures":
      return NextResponse.json(
        { error: reassignErrorMessage(err), code: err.code },
        { status: 400 },
      );
    case "not_reassignable":
      return NextResponse.json(
        {
          error: reassignErrorMessage(err),
          code: err.code,
        },
        { status: 400 },
      );
    case "qty_mismatch":
      return NextResponse.json(
        {
          error: reassignErrorMessage(err),
          code: err.code,
          expected: err.expected,
          got: err.got,
          soldShort: err.soldShort,
        },
        { status: 400 },
      );
    case "lot_not_in_scope":
      return NextResponse.json(
        {
          error: reassignErrorMessage(err),
          code: err.code,
          lotId: err.lotId,
        },
        { status: 400 },
      );
    case "short_already_covered":
      return NextResponse.json(
        {
          error: reassignErrorMessage(err),
          code: err.code,
          closeTxId: err.closeTxId,
          shortQty: err.shortQty,
          coveredQty: err.coveredQty,
        },
        { status: 400 },
      );
    case "lot_bought_after_sale":
      return NextResponse.json(
        {
          error: reassignErrorMessage(err),
          code: err.code,
          lotId: err.lotId,
          lotOpenDate: err.lotOpenDate,
          closeDate: err.closeDate,
          alreadyTaken: err.alreadyTaken,
        },
        { status: 400 },
      );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ holdingId: string }> },
) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  try {
    const { holdingId: holdingIdRaw } = await params;
    const holdingId = parseInt(holdingIdRaw, 10);
    if (!Number.isFinite(holdingId) || holdingId <= 0) {
      return NextResponse.json(
        { error: "holdingId must be a positive integer" },
        { status: 400 },
      );
    }

    const body = await request.json();
    const parsed = validateBody(body, bodySchema);
    if (parsed.error) return parsed.error;
    const { closeTxId, perLotQty, preview } = parsed.data;
    const dryRun = preview !== false; // default = preview/dry-run

    const result = await reassignClosureLots(
      auth.userId,
      { holdingId, closeTxId, perLotQty },
      { dryRun, dek: auth.dek },
    );

    if (!result.ok) return mapReassignError(result);

    return NextResponse.json({
      preview: result.preview,
      committed: !dryRun,
    });
  } catch (error) {
    await logApiError(
      "POST",
      "/api/portfolio/holdings/[holdingId]/lots/reassign",
      error,
      auth.userId,
    );
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to reassign lots") },
      { status: 500 },
    );
  }
}
