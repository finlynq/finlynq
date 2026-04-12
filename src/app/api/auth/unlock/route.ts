import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken, AUTH_COOKIE } from "@/lib/auth";
import { getUserById } from "@/lib/auth/queries";

/**
 * PostgreSQL-only mode
 *
 * This endpoint previously handled SQLite passphrase unlock, setup, rekey, and lock.
 * In PostgreSQL-only mode, these are no longer applicable.
 *
 * GET: Check authentication status (account-based, not passphrase-based)
 * POST: Return 403 (passphrase unlock not available)
 */

export async function GET(request: NextRequest) {
  // PostgreSQL mode only - check for a valid account session
  let clientUnlocked = false;
  let isAdmin = false;
  const token = request.cookies.get(AUTH_COOKIE)?.value;
  if (token) {
    const payload = await verifySessionToken(token);
    clientUnlocked = payload !== null;
    if (payload !== null) {
      const user = await getUserById(payload.sub);
      isAdmin = user?.role === "admin";
    }
  }
  return NextResponse.json({
    unlocked: clientUnlocked,
    needsSetup: false,
    mode: "managed",
    authMethod: "account",
    hasExistingData: false,
    isAdmin,
  });
}

export async function POST(request: NextRequest) {
  // In PostgreSQL-only mode, passphrase operations are not available
  return NextResponse.json(
    { error: "Passphrase unlock is not available. Use /api/auth/login instead." },
    { status: 403 }
  );
}
