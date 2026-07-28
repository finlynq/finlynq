/**
 * DELETE /api/data — the "Clear All Data" danger-zone action on
 * /settings/data. Removes every per-user row but KEEPS the account, then sends
 * the user back through onboarding.
 *
 * Delegates to the shared `clearAllUserData`, which runs the same audited,
 * FK-ordered, single-transaction body as the wipe and delete-account paths.
 * This route previously carried its own hand-rolled list of 15 `db.delete()`
 * calls outside a transaction — see the `clearAllUserData` header for what that
 * cost (surviving settings, no onboarding replay, and a half-wiped account when
 * the un-ordered `accounts` delete 23503'd).
 *
 * `tests/delete-all-user-data-coverage.test.ts` asserts this file contains no
 * deletes of its own, so the third list cannot grow back.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { clearAllUserData } from "@/lib/auth/queries";
import { invalidateUser as invalidateUserTxCache } from "@/lib/mcp/user-tx-cache";
import { logApiError, safeErrorMessage } from "@/lib/validate";

export async function DELETE(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;

  try {
    await clearAllUserData(userId);
    invalidateUserTxCache(userId);
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    await logApiError("DELETE", "/api/data", error, userId);
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to clear data") },
      { status: 500 },
    );
  }
}
