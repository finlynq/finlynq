import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { disconnectSimpleFin } from "@/lib/external-import/simplefin-orchestrator";

/**
 * DELETE /api/settings/bank-feeds/simplefin/disconnect
 *
 * Removes the stored access URL + account map. Does not delete already-imported
 * bank_transactions. Delete-only — no DEK needed.
 */
export async function DELETE(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  await disconnectSimpleFin(auth.context.userId);
  return NextResponse.json({ disconnected: true });
}
