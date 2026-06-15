/**
 * GET /api/portfolio/holdings/[holdingId]/lots?accountId=<opt>
 *
 * FINLYNQ-176 — read-only lot inspector data. Returns every lot for a
 * holding (open / closed / transferred-out) and every closure that
 * consumes those lots, with the per-closure realized gain. Powers the
 * lot-inspector dialog so users can see how their lots are being consumed
 * (which sell/transfer landed on which lot, at what cost + proceeds).
 *
 * Distinct from the existing GET /api/portfolio/lots?holdingId=N (which
 * powers the SellForm LotPicker and returns lots only): this route also
 * returns the closures and is shaped for the inspector. Kept as a separate
 * endpoint so the picker's byte-stable contract is untouched.
 *
 * Auth: requireAuth — no DEK needed (lot + closure rows carry no encrypted
 * fields). Cross-tenant scoping enforced via the userId predicate.
 *
 * 200: {
 *   lots: Array<{ id, accountId, openTxId, openDate, side, origin, status,
 *                 qtyOriginal, qtyRemaining, costPerShare, currency }>,
 *   closures: Array<{ id, lotId, closeTxId, closeDate, qtyClosed,
 *                     proceedsPerShare, costPerShare, realizedGain,
 *                     currency, closeKind }>,
 * }
 */

import { NextRequest, NextResponse } from "next/server";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireAuth } from "@/lib/auth/require-auth";
import { logApiError, safeErrorMessage } from "@/lib/validate";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ holdingId: string }> },
) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;
  try {
    const { holdingId: holdingIdRaw } = await params;
    const holdingId = parseInt(holdingIdRaw, 10);
    if (!Number.isFinite(holdingId) || holdingId <= 0) {
      return NextResponse.json(
        { error: "holdingId must be a positive integer" },
        { status: 400 },
      );
    }
    const accountIdRaw = request.nextUrl.searchParams.get("accountId");
    const accountId =
      accountIdRaw && /^\d+$/.test(accountIdRaw)
        ? parseInt(accountIdRaw, 10)
        : null;

    const lotConditions = [
      eq(schema.holdingLots.userId, userId),
      eq(schema.holdingLots.holdingId, holdingId),
    ];
    if (accountId != null) {
      lotConditions.push(eq(schema.holdingLots.accountId, accountId));
    }

    const lotRows = await db
      .select()
      .from(schema.holdingLots)
      .where(and(...lotConditions))
      .orderBy(asc(schema.holdingLots.openDate), asc(schema.holdingLots.id));

    const lots = lotRows.map((r) => ({
      id: r.id,
      accountId: r.accountId,
      openTxId: r.openTxId,
      openDate: r.openDate,
      side: ((r as { side?: string | null }).side ?? "long") as "long" | "short",
      origin: r.origin,
      status: r.status,
      qtyOriginal: Number(r.qtyOriginal),
      qtyRemaining: Number(r.qtyRemaining),
      costPerShare: Number(r.costPerShare),
      currency: r.currency,
    }));

    // Closures for these lots only (scoped to the holding's lots).
    const lotIds = lots.map((l) => l.id);
    const closureRows =
      lotIds.length > 0
        ? await db
            .select()
            .from(schema.holdingLotClosures)
            .where(
              and(
                eq(schema.holdingLotClosures.userId, userId),
                inArray(schema.holdingLotClosures.lotId, lotIds),
              ),
            )
            .orderBy(
              asc(schema.holdingLotClosures.closeDate),
              asc(schema.holdingLotClosures.id),
            )
        : [];

    const closures = closureRows.map((r) => ({
      id: r.id,
      lotId: r.lotId,
      closeTxId: r.closeTxId,
      closeDate: r.closeDate,
      qtyClosed: Number(r.qtyClosed),
      proceedsPerShare: Number(r.proceedsPerShare),
      costPerShare: Number(r.costPerShare),
      realizedGain: Number(r.realizedGain),
      currency: r.currency,
      closeKind: r.closeKind,
    }));

    return NextResponse.json({ lots, closures });
  } catch (error) {
    await logApiError(
      "GET",
      "/api/portfolio/holdings/[holdingId]/lots",
      error,
      userId,
    );
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to load lots") },
      { status: 500 },
    );
  }
}
