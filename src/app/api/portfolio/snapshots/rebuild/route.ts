/**
 * POST /api/portfolio/snapshots/rebuild
 *
 * Kicks off a re-materialize of the user's daily `portfolio_snapshots` from
 * `fromDate` (default: their earliest transaction) to today, then returns 202
 * IMMEDIATELY. The walk runs fire-and-forget in a closure that holds the
 * captured session DEK and reports per-day progress into the HMR-safe
 * `globalThis` rebuild registry (FINLYNQ-205); the client polls
 * `GET /api/portfolio/snapshots/rebuild/status` for `{ running, daysProcessed,
 * totalDays, lastResult }`. Running state therefore survives a browser reload
 * (the registry is server-side) and is shared across both mount points (the
 * Settings card + the net-worth chart empty-state). Backs the "Rebuild
 * investment history" button. Idempotent on the snapshot unique index.
 *
 * Requires a real session DEK (`requireEncryption` → 423 if absent). Post
 * Stream D Phase 4 holding symbols are ENCRYPTED, so pricing a holding needs
 * the DEK to decrypt the symbol — without it `getHoldingsValueByAccount`
 * mis-values stock holdings (treats share counts as $1/unit). A DEK-less
 * rebuild would write garbage, so we refuse rather than corrupt history. This
 * is also why the auto-rebuild is a DEK-bearing self-heal on chart load
 * (see /api/net-worth-history) rather than a blind background cron.
 *
 * Guards against an overlapping per-user run (409). plan/net-worth-over-time.md
 * Part B.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { logApiError } from "@/lib/validate";
import {
  rebuildPortfolioSnapshots,
  reportRebuildProgress,
  tryBeginRebuild,
  endRebuild,
} from "@/lib/portfolio/snapshots/rebuild";
import { clearDirtyIfUnchanged, listDirtySnapshotUsers } from "@/lib/portfolio/snapshots/dirty";

export async function POST(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const { userId, dek } = auth;

  if (!tryBeginRebuild(userId)) {
    return NextResponse.json(
      { error: "A rebuild is already running for your account. Please wait.", code: "rebuild_in_progress", running: true },
      { status: 409 },
    );
  }

  let fromDate: string | undefined;
  try {
    const body = await request.json();
    if (body && typeof body.fromDate === "string") fromDate = body.fromDate;
  } catch {
    /* empty body is fine */
  }

  // Fire-and-forget the walk: it holds the captured DEK and reports per-day
  // progress into the globalThis registry. The standalone Node server persists
  // the work across this request returning; the client polls the status route.
  void (async () => {
    try {
      const summary = await rebuildPortfolioSnapshots(
        userId,
        fromDate ?? null,
        null,
        dek,
        (done, total, phase) => reportRebuildProgress(userId, done, total, phase),
      );

      // The manual rebuild covers whatever the auto-drain would have — clear any
      // pending dirty row that hasn't been re-stamped since before this run.
      try {
        const dirty = await listDirtySnapshotUsers();
        const mine = dirty.find((d) => d.userId === userId);
        if (mine) await clearDirtyIfUnchanged(userId, mine.markedAt);
      } catch {
        /* dirty-row cleanup is best-effort */
      }

      endRebuild(userId, { result: summary });
    } catch (error: unknown) {
      await logApiError("POST", "/api/portfolio/snapshots/rebuild", error, userId);
      const message = error instanceof Error ? error.message : "Rebuild failed";
      endRebuild(userId, { error: message });
    }
  })();

  // 202: accepted, running in the background. Client polls the status route.
  return NextResponse.json({ started: true, running: true }, { status: 202 });
}
