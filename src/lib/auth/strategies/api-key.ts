/**
 * API Key Auth Strategy — validates X-API-Key header.
 *
 * Works in both self-hosted and managed editions.
 * In self-hosted mode, requires the DB to be unlocked first.
 * In managed mode, the API key is scoped to a specific user.
 */

import { NextRequest, NextResponse } from "next/server";
import { isUnlocked, DEFAULT_USER_ID } from "@/db";
import { getDialect } from "@/db";
import { validateApiKey } from "@/lib/api-auth";
import type { AuthStrategy, AuthResult } from "../strategy";

export class ApiKeyStrategy implements AuthStrategy {
  readonly method = "api_key" as const;

  authenticate(request: NextRequest): AuthResult {
    const headerKey = request.headers.get("X-API-Key");

    if (!headerKey) {
      return {
        authenticated: false,
        response: NextResponse.json(
          { error: "Missing X-API-Key header" },
          { status: 401 }
        ),
      };
    }

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

    const error = validateApiKey(request);
    if (error) {
      return {
        authenticated: false,
        response: NextResponse.json({ error }, { status: 401 }),
      };
    }

    return {
      authenticated: true,
      context: {
        userId: DEFAULT_USER_ID, // TODO: scope to user in managed mode
        method: "api_key",
        mfaVerified: false,
      },
    };
  }
}
