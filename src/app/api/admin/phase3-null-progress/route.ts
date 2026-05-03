/**
 * GET /api/admin/phase3-null-progress — Stream D Phase 3 NULL state.
 *
 * Stream D Phase 4 (2026-05-03) physically dropped the plaintext columns.
 * The per-user lazy NULL helper is gone; this endpoint now returns a static
 * "done" payload so the admin UI doesn't break, and to make the cutover
 * visible to operators querying it.
 *
 * Admin-only.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/require-admin";

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (!auth.authenticated) return auth.response;

  return NextResponse.json({
    phase: "phase4-dropped",
    note: "Stream D Phase 4 physically dropped the plaintext name/alias/symbol columns. The per-user lazy NULL flow is obsolete.",
    usersTotal: null,
    usersDone: null,
    usersPending: 0,
    pendingDetail: [],
  });
}
