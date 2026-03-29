/**
 * Passphrase Auth Strategy — for the self-hosted product.
 *
 * Wraps the existing requireUnlock() pattern: the database is encrypted
 * with the user's passphrase, so "authenticated" means "DB is unlocked."
 *
 * In self-hosted mode there is a single implicit user (DEFAULT_USER_ID).
 */

import { NextResponse } from "next/server";
import { isUnlocked, DEFAULT_USER_ID } from "@/db";
import type { AuthStrategy, AuthResult } from "../strategy";

export class PassphraseStrategy implements AuthStrategy {
  readonly method = "passphrase" as const;

  authenticate(): AuthResult {
    if (!isUnlocked()) {
      return {
        authenticated: false,
        response: NextResponse.json(
          { error: "Database is locked. Enter your passphrase to unlock." },
          { status: 423 }
        ),
      };
    }

    return {
      authenticated: true,
      context: {
        userId: DEFAULT_USER_ID,
        method: "passphrase",
        mfaVerified: false, // MFA checked separately if enabled
      },
    };
  }
}
