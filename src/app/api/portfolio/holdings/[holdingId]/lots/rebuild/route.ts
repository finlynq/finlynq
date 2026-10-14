/**
 * POST /api/portfolio/holdings/[holdingId]/lots/rebuild — FINLYNQ
 *
 * Targeted lot rebuild for ONE (security, account). The cure for an
 * out-of-order import: when a sell was recorded before its buy, the live
 * engine opened a phantom SHORT. Replaying the position's transactions in
 * chronological order opens the long first, so the sell closes it as a long.
 *
 * Scope: the position the inspector is showing — every portfolio_holding that
 * clusters under the SAME security (security_id), within the SAME account as
 * the clicked holding. Lots never cross accounts, so this is self-contained.
 *
 * Wipes + replays ONLY holding_lots / holding_lot_closures for that scope.
 * NEVER touches any `transactions` row — those are the source of truth the
 * replay reads from, so the only downside of a bad run is "run it again."
 *
 * Body: { } (none required — accountId + security cluster derive from the
 *   holding). Returns { lotsWritten, closuresWritten, txProcessed, warnings }.
 *
 * Auth: requireEncryption — the replay resolves the Dividends category (DEK).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { logApiError, safeErrorMessage } from "@/lib/validate";
import { rebuildLotsForPosition } from "@/lib/portfolio/lots/backfill";
import { resolvePositionScope } from "@/lib/portfolio/lots/inspect";

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

    // The clicked holding (owner-scoped) and every position clustering under
    // the same security IN THIS ACCOUNT. The account comes from the holding
    // itself, so the scope can't be spoofed cross-account. Shared with the
    // settings switch and MCP `manage_lots(op:"rebuild")`.
    const scope = await resolvePositionScope(auth.userId, holdingId);
    if (!scope) {
      return NextResponse.json(
        { error: "Holding not found" },
        { status: 404 },
      );
    }
    const { holdingIds, accountId } = scope;

    const result = await rebuildLotsForPosition(auth.userId, auth.dek, {
      holdingIds,
      accountId,
    });

    return NextResponse.json({
      lotsWritten: result.lotsWritten,
      closuresWritten: result.closuresWritten,
      txProcessed: result.txProcessed,
      holdingIds,
      accountId,
      // `errors` carries non-fatal warnings (cross-account
      // transfer legs rebuilt within the account) — surfaced to the user.
      warnings: result.errors,
    });
  } catch (error) {
    await logApiError(
      "POST",
      "/api/portfolio/holdings/[holdingId]/lots/rebuild",
      error,
      auth.userId,
    );
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to rebuild lots") },
      { status: 500 },
    );
  }
}
