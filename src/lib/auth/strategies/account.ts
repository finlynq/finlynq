/**
 * Account Auth Strategy — for the managed hosted product.
 *
 * Authenticates via JWT bearer tokens issued after email/password login.
 * Tokens carry the user ID and MFA status for downstream query scoping.
 */

import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken } from "../jwt";
import { getDEK } from "@/lib/crypto/dek-cache";
import type { AuthStrategy, AuthResult } from "../strategy";

const AUTH_COOKIE = "pf_session";

export class AccountStrategy implements AuthStrategy {
  readonly method = "account" as const;

  async authenticate(request: NextRequest): Promise<AuthResult> {
    // Try Authorization header first, then session cookie
    const token = extractToken(request);

    if (!token) {
      return {
        authenticated: false,
        response: NextResponse.json(
          { error: "Authentication required. Please log in." },
          { status: 401 }
        ),
      };
    }

    const payload = await verifySessionToken(token);

    if (!payload || !payload.sub) {
      return {
        authenticated: false,
        response: NextResponse.json(
          { error: "Invalid or expired session. Please log in again." },
          { status: 401 }
        ),
      };
    }

    // DEK lives in the in-memory cache, populated on login. A cache miss here
    // means the server restarted since the user's last login — the JWT is
    // still valid but the key to decrypt their data isn't in memory. The
    // caller decides whether to 423 (encrypted work) or proceed (plaintext-only
    // routes like /api/usage).
    const sessionId = (payload.jti as string | undefined) ?? null;
    const dek = sessionId ? getDEK(sessionId) : null;

    return {
      authenticated: true,
      context: {
        userId: payload.sub,
        method: "account",
        mfaVerified: payload.mfa ?? false,
        dek,
        sessionId,
      },
    };
  }
}

/** Extract JWT from Authorization header or session cookie */
function extractToken(request: NextRequest): string | null {
  // Bearer token
  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  // Session cookie
  const cookie = request.cookies.get(AUTH_COOKIE);
  return cookie?.value ?? null;
}

export { AUTH_COOKIE };
