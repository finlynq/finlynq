/**
 * GET /api/portfolio/snapshots/rebuild/status
 *
 * Reports the caller's current/last "Rebuild balance history" run from the
 * HMR-safe `globalThis` rebuild registry (FINLYNQ-205). The manual rebuild route
 * runs the day-by-day walk fire-and-forget and reports per-day progress here;
 * the "Rebuild balance history" button (Settings → Data + the
 * net-worth chart empty-state) polls this so:
 *   - a reload mid-rebuild still shows the in-progress state (the registry is
 *     server-side, not local component state), and
 *   - both mount points show identical progress.
 *
 * Read-only — no DEK needed (`requireAuth`, not `requireEncryption`). Returns
 * `{ running, phase, daysProcessed, totalDays, lastResult, error }`; `phase`
 * ('investment'|'cash') tells the button which leg the counters describe so a
 * cash-only rebuild gets a determinate bar + the right label (FINLYNQ-230).
 * `running:false` with no `lastResult` means "no rebuild has run this process".
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
      phase: "investment",
      daysProcessed: 0,
      totalDays: 0,
      lastResult: null,
      error: null,
    });
  }

  return NextResponse.json({
    running: p.running,
    phase: p.phase,
    daysProcessed: p.daysProcessed,
    totalDays: p.totalDays,
    lastResult: p.lastResult,
    error: p.error,
  });
}
