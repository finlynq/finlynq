/**
 * /api/settings/connected-apps — per-user OAuth grant management (FINLYNQ-154).
 *
 *   GET    — list the user's live OAuth grants (client name, scope, created_at).
 *   DELETE — revoke ONE grant by its row id (?id=N). Kills the access + refresh
 *            sides of that grant at once (one row holds both).
 *
 * Neither path needs a DEK — listing is metadata and revoking just flips
 * `revoked_at`. So both gate on `requireAuth`, not `requireEncryption`.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { listConnectedApps, revokeGrantById } from "@/lib/oauth";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const apps = await listConnectedApps(auth.context.userId);
  return NextResponse.json({ apps });
}

export async function DELETE(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;

  const idParam = request.nextUrl.searchParams.get("id");
  const grantId = idParam ? Number(idParam) : NaN;
  if (!Number.isInteger(grantId) || grantId <= 0) {
    return NextResponse.json(
      { error: "A valid grant id is required" },
      { status: 400 }
    );
  }

  // Owner-scoped revoke. A false return means the id was unknown, already
  // revoked, or owned by another user — all the same "nothing to do" to the
  // caller, so we 404 rather than confirm the row's existence.
  const revoked = await revokeGrantById(auth.context.userId, grantId);
  if (!revoked) {
    return NextResponse.json(
      { error: "Connected app not found or already revoked" },
      { status: 404 }
    );
  }

  return NextResponse.json({ success: true });
}
