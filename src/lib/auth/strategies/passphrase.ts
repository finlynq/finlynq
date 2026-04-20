/**
 * Passphrase Auth Strategy — for the self-hosted product.
 *
 * Requires both that the DB is unlocked AND that the client presents
 * a valid session cookie (pf_session). This prevents unauthenticated
 * clients on the same network from piggy-backing on another client's
 * unlock.
 *
 * In self-hosted mode there is a single implicit user (DEFAULT_USER_ID).
 */

import { NextRequest, NextResponse } from "next/server";
import { isUnlocked, DEFAULT_USER_ID } from "@/db";
import { verifySessionToken } from "../jwt";
import { AUTH_COOKIE } from "./account";
import type { AuthStrategy, AuthResult } from "../strategy";

export class PassphraseStrategy implements AuthStrategy {
  readonly method = "passphrase" as const;

  async authenticate(request: NextRequest): Promise<AuthResult> {
    if (!isUnlocked()) {
      return {
        authenticated: false,
        response: NextResponse.json(
          { error: "Database is locked. Enter your passphrase to unlock." },
          { status: 423 }
        ),
      };
    }

    // Validate per-client session cookie
    const token = request.cookies.get(AUTH_COOKIE)?.value;
    if (!token) {
      return {
        authenticated: false,
        response: NextResponse.json(
          { error: "Session required. Enter your passphrase to unlock." },
          { status: 401 }
        ),
      };
    }

    const payload = await verifySessionToken(token);
    if (!payload || payload.sub !== DEFAULT_USER_ID) {
      return {
        authenticated: false,
        response: NextResponse.json(
          { error: "Invalid or expired session. Enter your passphrase to unlock." },
          { status: 401 }
        ),
      };
    }

    return {
      authenticated: true,
      context: {
        userId: DEFAULT_USER_ID,
        method: "passphrase",
        mfaVerified: false,
        // Self-hosted (SQLite) mode is retired; kept as a null DEK stub so the
        // AuthContext interface stays total.
        dek: null,
        sessionId: null,
      },
    };
  }
}
