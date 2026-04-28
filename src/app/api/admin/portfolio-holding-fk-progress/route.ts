/**
 * GET /api/admin/portfolio-holding-fk-progress — Report how many transaction
 * rows still have NULL portfolio_holding_id but a populated portfolio_holding
 * text column. Admin-only.
 *
 * Zero `withoutFk` means Phase 5 cutover (NULL the plaintext column on
 * backfilled rows + drop portfolioHolding from TX_ENCRYPTED_FIELDS) is safe.
 * Until then, any user who hasn't logged in since the FK deploy still has
 * legacy txs — backfill runs lazily on their next login (see
 * src/lib/crypto/portfolio-holding-fk-backfill.ts).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/require-admin";
import { portfolioHoldingFkProgress } from "@/lib/crypto/portfolio-holding-fk-backfill";

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (!auth.authenticated) return auth.response;

  const counts = await portfolioHoldingFkProgress();
  return NextResponse.json({
    complete: counts.withoutFk === 0,
    ...counts,
  });
}
