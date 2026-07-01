import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { getSimpleFinStatus } from "@/lib/external-import/simplefin-orchestrator";

/**
 * GET /api/settings/bank-feeds/simplefin/status
 *
 * Returns { connected, lastSyncAt }. Read-only — no DEK needed (connection
 * presence + last batch timestamp are derivable without decrypting anything).
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const status = await getSimpleFinStatus(auth.context.userId);
  return NextResponse.json(status);
}
