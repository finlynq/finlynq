/**
 * Account Auth Strategy — for the managed hosted product.
 *
 * Authenticates via JWT bearer tokens issued after email/password login.
 * Tokens carry the user ID and MFA status for downstream query scoping.
 */

import { NextRequest, NextResponse } from "next/server";
import { verifySessionTokenDetailed } from "../jwt";
import { getDEK } from "@/lib/crypto/dek-cache";
import type { AuthStrategy, AuthResult } from "../strategy";

const AUTH_COOKIE = "pf_session";

/**
 * The single route that accepts a pending JWT (the MFA challenge step). Every
 * other route receiving a pending token gets 401 — a captured pending cookie
 * must not be replayable against dashboards or transactions (finding H-4).
 */
const MFA_VERIFY_PATH = "/api/auth/mfa/verify";

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

    const { payload, reason } = await verifySessionTokenDetailed(token);

    if (!payload || !payload.sub) {
      // Distinguish deploy-rotation from generic invalid — the client uses
      // the `code` field to show a tailored "we just updated Finlynq, please
      // sign in again" screen rather than a generic auth failure.
      if (reason === "deploy-reauth-required") {
        return {
          authenticated: false,
          response: NextResponse.json(
            {
              error:
                "Your session has expired due to a deployment. Please sign in again.",
              code: "deploy-reauth-required",
            },
            { status: 401 }
          ),
        };
      }
      // `revoked` is intentionally not surfaced as a distinct code — the user
      // logged out, they don't need a special UI. Same 401 generic shape so
      // a stolen-cookie attacker can't distinguish "logged out" from "garbage."
      return {
        authenticated: false,
        response: NextResponse.json(
          { error: "Invalid or expired session. Please log in again." },
          { status: 401 }
        ),
      };
    }

    // Pending JWTs (MFA challenge step) are only valid for /api/auth/mfa/verify.
    // Any other route with a pending token = 401 — a captured pending cookie
    // must not access dashboards or transactions (finding H-4). The route
    // check uses `request.nextUrl.pathname` rather than headers so the gate
    // can't be defeated by a Host or X-Forwarded-* shenanigan.
    if (payload.pending) {
      let pathname = "";
      try {
        pathname = request.nextUrl.pathname;
      } catch {
        // If we can't read the URL we treat it as not-MFA-verify and reject.
      }
      if (pathname !== MFA_VERIFY_PATH) {
        return {
          authenticated: false,
          response: NextResponse.json(
            {
              error:
                "MFA verification required. Please complete the challenge before continuing.",
              code: "mfa-pending",
            },
            { status: 401 }
          ),
        };
      }
    }

    // DEK lives in the in-memory cache, populated on login. A cache miss here
    // means the server restarted since the user's last login — the JWT is
    // still valid but the key to decrypt their data isn't in memory. The
    // caller decides whether to 423 (encrypted work) or proceed (plaintext-only
    // routes like /api/usage). The cache requires both the jti AND the userId
    // to match (defense-in-depth against future jti-collision dev mistakes).
    const sessionId = (payload.jti as string | undefined) ?? null;
    const dek = sessionId ? getDEK(sessionId, payload.sub) : null;

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
