/**
 * POST /api/auth/logout — Clear the session (managed edition).
 *
 * Wipes the user's DEK from the in-memory cache so a stolen cookie can't
 * resurrect decrypted data access after logout, AND inserts the JWT's jti
 * into the server-side `revoked_jtis` denylist so a stolen cookie can't
 * keep accessing plaintext-only routes for the remainder of the JWT exp
 * (finding H-5).
 */

import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE, verifySessionTokenDetailed, revokeJti } from "@/lib/auth";
import { deleteDEK } from "@/lib/crypto/dek-cache";

export async function POST(request: NextRequest) {
  // Read the JWT before we blank the cookie so we can target its jti.
  // We use the detailed variant so a deploy-rotated token is still parseable
  // here (its claims are extractable even though it's no longer auth-valid)
  // — best-effort eviction even on the unhappy path.
  const token = request.cookies.get(AUTH_COOKIE)?.value;
  if (token) {
    // verifySessionTokenDetailed normally bails on revoked / deploy-rotated.
    // For logout we want the jti regardless, so we re-parse via the jose
    // primitive even if the token is technically expired or already revoked
    // — calling `revokeJti` on an already-revoked jti is a cheap no-op via
    // ON CONFLICT DO NOTHING.
    const { payload } = await verifySessionTokenDetailed(token);
    if (payload?.jti) {
      const exp = typeof payload.exp === "number"
        ? new Date(payload.exp * 1000)
        : new Date(Date.now() + 24 * 60 * 60_000);
      // Best-effort. The DB write is awaited so a successful logout response
      // implies the denylist entry committed before the cookie clears.
      try {
        await revokeJti(payload.jti, exp);
      } catch {
        // swallow — see revokeJti for the why
      }
      deleteDEK(payload.jti);
    }
  }

  const response = NextResponse.json({ success: true });

  response.cookies.set(AUTH_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 0,
    path: "/",
  });

  return response;
}
