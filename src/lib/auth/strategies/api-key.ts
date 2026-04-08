/**
 * API Key Auth Strategy — validates X-API-Key header.
 *
 * Works in both self-hosted and managed editions.
 * In self-hosted mode, requires the DB to be unlocked first.
 * In managed mode, the API key is scoped to a specific user.
 */

import { NextRequest, NextResponse } from "next/server";
import { isUnlocked } from "@/db";
import { getDialect } from "@/db";
import { validateApiKey } from "@/lib/api-auth";
import type { AuthStrategy, AuthResult } from "../strategy";

export class ApiKeyStrategy implements AuthStrategy {
  readonly method = "api_key" as const;

  async authenticate(request: NextRequest): Promise<AuthResult> {
    // In self-hosted mode, DB must be unlocked to validate the key
    if (getDialect() === "sqlite" && !isUnlocked()) {
      return {
        authenticated: false,
        response: NextResponse.json(
          { error: "Database is locked. Enter your passphrase to unlock." },
          { status: 423 }
        ),
      };
    }

    const result = await validateApiKey(request);
    if (typeof result === "string") {
      return {
        authenticated: false,
        response: NextResponse.json({ error: result }, { status: 401 }),
      };
    }

    return {
      authenticated: true,
      context: {
        userId: result.userId,
        method: "api_key",
        mfaVerified: false,
      },
    };
  }
}
