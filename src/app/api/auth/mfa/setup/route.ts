/**
 * POST /api/auth/mfa/setup — Enable or disable TOTP MFA.
 *
 * Actions:
 *   generate: Generate a new TOTP secret and provisioning URI
 *   enable:   Verify a code and enable MFA
 *   disable:  Verify a code and disable MFA
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth, generateMfaSecret, verifyMfaCode } from "@/lib/auth";
import {
  getUserById,
  enableUserMfa,
  disableUserMfa,
} from "@/lib/auth/queries";
import { validateBody, safeErrorMessage } from "@/lib/validate";
import { getDEK } from "@/lib/crypto/dek-cache";
import { decryptField } from "@/lib/crypto/envelope";

const setupSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("generate") }),
  z.object({
    action: z.literal("enable"),
    secret: z.string().min(1, "Secret is required"),
    code: z.string().length(6, "Code must be 6 digits"),
  }),
  z.object({
    action: z.literal("disable"),
    code: z.string().length(6, "Code must be 6 digits"),
  }),
]);

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;

  try {
    const body = await request.json();
    const parsed = validateBody(body, setupSchema);
    if (parsed.error) return parsed.error;

    const { userId, sessionId } = auth.context;
    const user = await getUserById(userId);
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    switch (parsed.data.action) {
      case "generate": {
        // generateMfaSecret expects a label for the otpauth URI. Prefer email,
        // fall back to username, then to a generic "Finlynq Account" so users
        // who registered without an email still see a sensible authenticator-app entry.
        const label = user.email ?? user.username ?? "Finlynq Account";
        const { secret, uri } = generateMfaSecret(label);
        return NextResponse.json({ secret, uri });
      }

      case "enable": {
        const { secret, code } = parsed.data;
        if (!verifyMfaCode(secret, code)) {
          return NextResponse.json(
            { error: "Invalid verification code. Please try again." },
            { status: 400 }
          );
        }
        // Need the DEK to encrypt the TOTP seed at rest. Enabling MFA requires
        // an active encrypted session; send the user to re-login if the DEK
        // is missing (stale deploy cache, legacy unencrypted account, etc.).
        const dek = sessionId ? getDEK(sessionId) : null;
        if (!dek) {
          return NextResponse.json(
            { error: "Session expired. Please sign in again to enable MFA." },
            { status: 423 }
          );
        }
        await enableUserMfa(userId, secret, dek);
        return NextResponse.json({ success: true, mfaEnabled: true });
      }

      case "disable": {
        if (!user.mfaEnabled || !user.mfaSecret) {
          return NextResponse.json(
            { error: "MFA is not enabled." },
            { status: 400 }
          );
        }
        // Decrypt stored MFA secret with the session DEK.
        const dek = sessionId ? getDEK(sessionId) : null;
        if (!dek) {
          return NextResponse.json(
            { error: "Session expired. Please sign in again to disable MFA." },
            { status: 423 }
          );
        }
        let decryptedSecret: string | null;
        try {
          decryptedSecret = decryptField(dek, user.mfaSecret);
        } catch {
          return NextResponse.json(
            { error: "MFA secret could not be decrypted. Please contact support." },
            { status: 500 }
          );
        }
        if (!decryptedSecret || !verifyMfaCode(decryptedSecret, parsed.data.code)) {
          return NextResponse.json(
            { error: "Invalid verification code." },
            { status: 400 }
          );
        }
        await disableUserMfa(userId);
        return NextResponse.json({ success: true, mfaEnabled: false });
      }
    }
  } catch (error) {
    return NextResponse.json(
      { error: safeErrorMessage(error, "MFA setup failed") },
      { status: 500 }
    );
  }
}
