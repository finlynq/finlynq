/**
 * Admin OAuth-grants API (FINLYNQ-167).
 *
 * GET    /api/admin/oauth-grants — list every live OAuth grant across all users
 *        (client name, user, scope, created_at, last_used_at). Operator-scoped.
 * DELETE /api/admin/oauth-grants?id=N — revoke ONE grant by row id (kills the
 *        access + refresh sides at once). NOT owner-scoped — the admin acts
 *        across users.
 *
 * Hand-rolls `requireAdmin` (NOT apiHandler) + the managed-mode postgres-dialect
 * guard, mirroring the other /api/admin/* routes. Neither path needs a DEK:
 * listing is metadata; revoking just flips `revoked_at`.
 */

import { NextRequest, NextResponse } from "next/server";
import { getDialect } from "@/db";
import { requireAdmin } from "@/lib/auth/require-admin";
import { listAllGrants, revokeGrantByIdAdmin } from "@/lib/oauth";

export async function GET(request: NextRequest) {
  if (getDialect() !== "postgres") {
    return NextResponse.json(
      { error: "Admin features are only available in managed mode." },
      { status: 403 }
    );
  }

  const auth = await requireAdmin(request);
  if (!auth.authenticated) return auth.response;

  const grants = await listAllGrants();
  return NextResponse.json({ grants });
}

export async function DELETE(request: NextRequest) {
  if (getDialect() !== "postgres") {
    return NextResponse.json(
      { error: "Admin features are only available in managed mode." },
      { status: 403 }
    );
  }

  const auth = await requireAdmin(request);
  if (!auth.authenticated) return auth.response;

  const idParam = request.nextUrl.searchParams.get("id");
  const grantId = idParam ? Number(idParam) : NaN;
  if (!Number.isInteger(grantId) || grantId <= 0) {
    return NextResponse.json(
      { error: "A valid grant id is required" },
      { status: 400 }
    );
  }

  // Admin (cross-user) revoke. A false return means the id was unknown or
  // already revoked — same "nothing to do" to the caller, so we 404.
  const revoked = await revokeGrantByIdAdmin(grantId);
  if (!revoked) {
    return NextResponse.json(
      { error: "Grant not found or already revoked" },
      { status: 404 }
    );
  }

  return NextResponse.json({ success: true });
}
