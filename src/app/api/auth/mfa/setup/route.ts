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

    const { userId } = auth.context;
    const user = getUserById(userId);
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    switch (parsed.data.action) {
      case "generate": {
        const { secret, uri } = generateMfaSecret(user.email);
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
        enableUserMfa(userId, secret);
        return NextResponse.json({ success: true, mfaEnabled: true });
      }

      case "disable": {
        if (!user.mfaEnabled || !user.mfaSecret) {
          return NextResponse.json(
            { error: "MFA is not enabled." },
            { status: 400 }
          );
        }
        if (!verifyMfaCode(user.mfaSecret, parsed.data.code)) {
          return NextResponse.json(
            { error: "Invalid verification code." },
            { status: 400 }
          );
        }
        disableUserMfa(userId);
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
