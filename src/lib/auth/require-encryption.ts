/**
 * requireEncryption() — wrapper around requireAuth() for route handlers that
 * read or write encrypted columns.
 *
 * Returns a 423 Locked response if the session has no DEK (either because the
 * server restarted since the user's last login, or because this is an API-key
 * auth path that doesn't carry a DEK yet).
 *
 * Usage:
 *   const auth = await requireEncryption(request);
 *   if (!auth.ok) return auth.response;
 *   const { userId, dek } = auth;
 *   const payeeCipher = encryptField(dek, input.payee);
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "./require-auth";

export type EncryptionAuthResult =
  | { ok: true; userId: string; dek: Buffer; sessionId: string }
  | { ok: false; response: NextResponse };

export async function requireEncryption(
  request: NextRequest
): Promise<EncryptionAuthResult> {
  const auth = await requireAuth(request);
  if (!auth.authenticated) {
    return { ok: false, response: auth.response };
  }
  if (!auth.context.dek || !auth.context.sessionId) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: "session_locked",
          message:
            "Your session needs to be unlocked to read or write encrypted data. Please log in again in your browser.",
        },
        { status: 423 }
      ),
    };
  }
  return {
    ok: true,
    userId: auth.context.userId,
    dek: auth.context.dek,
    sessionId: auth.context.sessionId,
  };
}
