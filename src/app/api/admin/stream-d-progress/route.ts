/**
 * GET /api/admin/stream-d-progress — Report how many rows still have NULL
 * `*_ct` columns across the Stream D tables. Admin-only.
 *
 * Zero across every table means Phase 3 (drop plaintext + swap unique index)
 * is safe to run. Until then, any user who hasn't logged in since the
 * Stream D deploy still has un-encrypted names — backfill happens lazily on
 * their next login (see src/lib/crypto/stream-d-backfill.ts).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/require-admin";
import { streamDProgress } from "@/lib/crypto/stream-d-backfill";

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (!auth.authenticated) return auth.response;

  const rows = await streamDProgress();
  const remaining = rows.reduce((s, r) => s + r.remaining, 0);
  return NextResponse.json({
    complete: remaining === 0,
    totalRemaining: remaining,
    byTable: rows,
  });
}
