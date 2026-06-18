/**
 * Realized-gain endpoint — Phase 2 of plan/portfolio-lots-and-performance.md.
 *
 * GET /api/portfolio/realized-gains?from=&to=&taxYear=&holdingId=&accountId=&term=&format=csv
 *
 * Returns the same shape as the MCP HTTP `get_realized_gains` tool. CSV
 * stream when `format=csv`. Cross-tenant filters enforced via the
 * session DEK (decryptName returns null on mismatch — never leaks
 * another user's data) plus `userId` predicate in the helper.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { getDEK } from "@/lib/crypto/dek-cache";
import {
  augmentWithBaseCurrency,
  listRealizedGainClosures,
  realizedGainsToCsv,
  type RealizedGainsFilter,
} from "@/lib/portfolio/realized-gains";
import { getDisplayCurrency } from "@/lib/fx-service";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId, sessionId } = auth.context;
  const dek = sessionId ? getDEK(sessionId, userId) : null;

  const params = request.nextUrl.searchParams;
  const filter: RealizedGainsFilter = {
    from: params.get("from") ?? undefined,
    to: params.get("to") ?? undefined,
    taxYear: params.get("taxYear")
      ? parseInt(params.get("taxYear")!, 10)
      : undefined,
    holdingId: params.get("holdingId")
      ? parseInt(params.get("holdingId")!, 10)
      : undefined,
    accountId: params.get("accountId")
      ? parseInt(params.get("accountId")!, 10)
      : undefined,
    term: (params.get("term") as RealizedGainsFilter["term"]) ?? "all",
  };

  const result = await listRealizedGainClosures(userId, dek, filter);

  // FINLYNQ-183 — unified-currency augmentation when ?unified=1 is set.
  // The "unified" view converts every closure into the user's single
  // display currency (no separate base-currency concept / override). The
  // toggle still distinguishes per-row native currency vs the unified view.
  // (Legacy `?currency=base` is still accepted for backward-compat links.)
  const useUnified =
    params.get("unified") === "1" || params.get("currency") === "base";
  let augmented:
    | (typeof result & { totalRealizedGainInBase: number })
    | null = null;
  if (useUnified) {
    const displayCurrency = await getDisplayCurrency(userId);
    augmented = await augmentWithBaseCurrency(result, userId, displayCurrency);
  }

  if (params.get("format") === "csv") {
    const csv = realizedGainsToCsv(result);
    const filenameParts: string[] = ["realized-gains"];
    if (filter.taxYear) filenameParts.push(String(filter.taxYear));
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${filenameParts.join("-")}.csv"`,
      },
    });
  }

  return NextResponse.json({
    success: true,
    data: augmented ?? result,
  });
}
