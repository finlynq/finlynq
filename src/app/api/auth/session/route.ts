/**
 * GET /api/auth/session — Return the current session status.
 *
 * Works across both editions:
 * - Self-hosted: returns passphrase unlock status
 * - Managed: returns JWT session info
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);

  if (!auth.authenticated) {
    return NextResponse.json({
      authenticated: false,
      method: null,
      userId: null,
    });
  }

  return NextResponse.json({
    authenticated: true,
    method: auth.context.method,
    userId: auth.context.userId,
    mfaVerified: auth.context.mfaVerified,
  });
}
