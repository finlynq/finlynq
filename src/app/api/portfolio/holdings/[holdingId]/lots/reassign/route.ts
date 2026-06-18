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
 *   - Σ perLotQty.qty must equal the closure's total qty → 400 qty_mismatch.
 *   - every named lot must belong to the same (holding, account) as the
 *     close-tx (same-account-only) → 400 lot_not_in_scope.
 *   - the closure must be a plain SELL → 400 not_reassignable.
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

const bodySchema = z.object({
  closeTxId: z.number().int().positive(),
  perLotQty: z
    .array(
      z.object({
        lotId: z.number().int().positive(),
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
        { error: "Closure transaction not found for this holding", code: err.code },
        { status: 404 },
      );
    case "no_closures":
      return NextResponse.json(
        { error: "That transaction has no lot closures to reassign", code: err.code },
        { status: 400 },
      );
    case "not_reassignable":
      return NextResponse.json(
        {
          error: `Only plain sell closures can be reassigned (this is '${err.closeKind}')`,
          code: err.code,
        },
        { status: 400 },
      );
    case "qty_mismatch":
      return NextResponse.json(
        {
          error: `The chosen quantities (${err.got}) must total the closure quantity (${err.expected})`,
          code: err.code,
          expected: err.expected,
          got: err.got,
        },
        { status: 400 },
      );
    case "lot_not_in_scope":
      return NextResponse.json(
        {
          error: `Lot #${err.lotId} is not in this holding/account — reassignment is same-account only`,
          code: err.code,
          lotId: err.lotId,
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
