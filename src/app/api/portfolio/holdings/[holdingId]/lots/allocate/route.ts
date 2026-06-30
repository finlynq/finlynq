/**
 * POST /api/portfolio/holdings/[holdingId]/lots/allocate — FINLYNQ
 *
 * Whole-ticker lot allocation editor. The atomic, holding-wide successor to
 * the single-closure `/reassign` route: the client sends, per editable sell,
 * how many shares to close from each lot (a `lotId <= 0` entry opens a short
 * for the remainder), and this previews or commits the entire re-allocation
 * in one strict pass.
 *
 * Body: { accountId, spec, preview? }
 *   - spec: { [closeTxId]: Array<{ lotId, qty }> } — MUST cover every editable
 *     sell on the (holding, account).
 *   - preview:true (default) → dry-run; returns { preview }, writes NOTHING.
 *   - preview:false → STRICT commit; reverses every editable sell and
 *     re-closes each chronologically. Returns { preview, committed:true }.
 *
 * Reverses + re-closes only `holding_lot_closures` / `holding_lots` — NEVER a
 * `transactions` row. Position qty stays live SUM(quantity).
 *
 * Auth: requireEncryption — the commit resolves the Dividends category (DEK),
 * mirroring /reassign.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { validateBody, safeErrorMessage, logApiError } from "@/lib/validate";
import {
  applyHoldingAllocation,
  type AllocApplyError,
} from "@/lib/portfolio/lots/write-hooks";

const bodySchema = z.object({
  accountId: z.number().int().positive(),
  spec: z.record(
    z.string(),
    z.array(
      z.object({
        // 0 (SHORT_LOT_ID) = open a short for this qty; >0 = a real lot.
        lotId: z.number().int().min(0),
        qty: z.number().nonnegative(),
      }),
    ),
  ),
  preview: z.boolean().optional(),
});

function mapAllocError(err: AllocApplyError): NextResponse {
  switch (err.code) {
    case "holding_not_found":
      return NextResponse.json(
        { error: "No lots found for this holding/account", code: err.code },
        { status: 404 },
      );
    case "no_editable_sells":
      return NextResponse.json(
        { error: "This holding has no editable sell closures", code: err.code },
        { status: 400 },
      );
    case "unknown_close_tx":
      return NextResponse.json(
        { error: `Sell #${err.closeTxId} is not an editable sell on this holding`, code: err.code },
        { status: 400 },
      );
    case "incomplete_spec":
      return NextResponse.json(
        {
          error: `The allocation must cover every sell (missing: ${err.missing.join(", ")})`,
          code: err.code,
          missing: err.missing,
        },
        { status: 400 },
      );
    case "plan_invalid":
      return NextResponse.json(
        {
          error: err.preview.errors[0] ?? "Allocation is invalid",
          code: err.code,
          errorCode: err.preview.errorCode,
          errors: err.preview.errors,
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
    const { accountId, spec, preview } = parsed.data;
    const dryRun = preview !== false;

    // Normalize the string-keyed spec to the numeric-keyed shape the lib uses.
    const numSpec: Record<number, Array<{ lotId: number; qty: number }>> = {};
    for (const [k, v] of Object.entries(spec)) numSpec[Number(k)] = v;

    const result = await applyHoldingAllocation(
      auth.userId,
      { holdingId, accountId, spec: numSpec },
      { dryRun, dek: auth.dek },
    );

    if (!result.ok) return mapAllocError(result);

    return NextResponse.json({ preview: result.preview, committed: !dryRun });
  } catch (error) {
    await logApiError(
      "POST",
      "/api/portfolio/holdings/[holdingId]/lots/allocate",
      error,
      auth.userId,
    );
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to apply allocation") },
      { status: 500 },
    );
  }
}
