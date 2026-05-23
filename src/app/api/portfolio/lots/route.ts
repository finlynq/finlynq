/**
 * GET /api/portfolio/lots?holdingId=N[&accountId=M][&openOnly=1]
 *
 * Returns the user's lot rows for a specific holding. Powers the SellForm's
 * LotPicker so users can pick SPECIFIC lots to deplete (instead of the
 * default FIFO depletion the server runs when `lotSelection` is omitted).
 *
 * Response shape:
 *   { success: true, data: { lots: LotRow[] } }
 *
 * `openOnly=1` filters to `status='open' AND qty_remaining > 0`. Without it,
 * closed + transferred-out lots are also returned (useful for audit /
 * reporting consumers; the SellForm picker passes `openOnly=1`).
 *
 * Auth: requireAuth — no DEK needed (lot rows carry no encrypted fields).
 * Cross-tenant scoping enforced via the userId predicate.
 */

import { NextRequest, NextResponse } from "next/server";
import { and, asc, eq, gt } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireAuth } from "@/lib/auth/require-auth";
import { logApiError, safeErrorMessage } from "@/lib/validate";

interface LotRow {
  lotId: number;
  holdingId: number;
  accountId: number;
  openTxId: number;
  openDate: string;
  qtyOriginal: number;
  qtyRemaining: number;
  /** Alias of `qtyRemaining` for LotPicker compatibility — picker expects `qty`. */
  qty: number;
  costPerShare: number;
  costBasis: number;
  currency: string;
  origin: string;
  status: string;
  parentLotId: number | null;
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;
  try {
    const params = request.nextUrl.searchParams;
    const holdingIdRaw = params.get("holdingId");
    if (!holdingIdRaw) {
      return NextResponse.json(
        { error: "holdingId is required" },
        { status: 400 },
      );
    }
    const holdingId = parseInt(holdingIdRaw, 10);
    if (!Number.isFinite(holdingId) || holdingId <= 0) {
      return NextResponse.json(
        { error: "holdingId must be a positive integer" },
        { status: 400 },
      );
    }
    const accountIdRaw = params.get("accountId");
    const accountId =
      accountIdRaw && /^\d+$/.test(accountIdRaw)
        ? parseInt(accountIdRaw, 10)
        : null;
    const openOnly = params.get("openOnly") === "1";

    const conditions = [
      eq(schema.holdingLots.userId, userId),
      eq(schema.holdingLots.holdingId, holdingId),
    ];
    if (accountId != null) {
      conditions.push(eq(schema.holdingLots.accountId, accountId));
    }
    if (openOnly) {
      conditions.push(eq(schema.holdingLots.status, "open"));
      conditions.push(gt(schema.holdingLots.qtyRemaining, 0));
    }

    const rows = await db
      .select({
        lotId: schema.holdingLots.id,
        holdingId: schema.holdingLots.holdingId,
        accountId: schema.holdingLots.accountId,
        openTxId: schema.holdingLots.openTxId,
        openDate: schema.holdingLots.openDate,
        qtyOriginal: schema.holdingLots.qtyOriginal,
        qtyRemaining: schema.holdingLots.qtyRemaining,
        costPerShare: schema.holdingLots.costPerShare,
        currency: schema.holdingLots.currency,
        origin: schema.holdingLots.origin,
        status: schema.holdingLots.status,
        parentLotId: schema.holdingLots.parentLotId,
      })
      .from(schema.holdingLots)
      .where(and(...conditions))
      // FIFO order matches the engine's depletion order — picker can show
      // them in the same order the server would deplete by default.
      .orderBy(asc(schema.holdingLots.openDate), asc(schema.holdingLots.id));

    const lots: LotRow[] = rows.map((r) => {
      const qtyRem = Number(r.qtyRemaining);
      const cps = Number(r.costPerShare);
      return {
        lotId: r.lotId,
        holdingId: r.holdingId,
        accountId: r.accountId,
        openTxId: r.openTxId,
        openDate: r.openDate,
        qtyOriginal: Number(r.qtyOriginal),
        qtyRemaining: qtyRem,
        // LotPicker alias — keep both keys so other consumers can use the
        // more-explicit `qtyRemaining` while the SellForm picker stays on
        // the shorter `qty`.
        qty: qtyRem,
        costPerShare: cps,
        // Convenience: `cost_basis = qty_remaining * cost_per_share` in the
        // lot's currency. Pre-computed so the LotPicker doesn't have to.
        costBasis: qtyRem * cps,
        currency: r.currency,
        origin: r.origin,
        status: r.status,
        parentLotId: r.parentLotId,
      };
    });

    return NextResponse.json({
      success: true,
      data: { lots },
    });
  } catch (err: unknown) {
    await logApiError("GET", "/api/portfolio/lots", err, userId);
    return NextResponse.json(
      { error: safeErrorMessage(err, "Failed to list lots") },
      { status: 500 },
    );
  }
}
