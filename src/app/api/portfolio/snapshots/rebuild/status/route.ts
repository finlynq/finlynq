/**
 * GET /api/portfolio/snapshots/rebuild/status
 *
 * Reports the caller's current/last "Rebuild investment history" run from the
 * HMR-safe `globalThis` rebuild registry (FINLYNQ-205). The manual rebuild route
 * runs the day-by-day walk fire-and-forget and reports per-day progress here;
 * the "Rebuild investment history" button (Settings → Investments + the
 * net-worth chart empty-state) polls this so:
 *   - a reload mid-rebuild still shows the in-progress state (the registry is
 *     server-side, not local component state), and
 *   - both mount points show identical progress.
 *
 * Read-only — no DEK needed (`requireAuth`, not `requireEncryption`). Returns
 * `{ running, daysProcessed, totalDays, lastResult, error }`; `running:false`
 * with no `lastResult` means "no rebuild has run this process".
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { getRebuildProgress } from "@/lib/portfolio/snapshots/rebuild";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;

  const p = getRebuildProgress(userId);
  if (!p) {
    return NextResponse.json({
      running: false,
      daysProcessed: 0,
      totalDays: 0,
      lastResult: null,
      error: null,
    });
  }

  return NextResponse.json({
    running: p.running,
    daysProcessed: p.daysProcessed,
    totalDays: p.totalDays,
    lastResult: p.lastResult,
    error: p.error,
  });
}
