/**
 * API Key Auth Strategy — validates X-API-Key or Authorization: Bearer pf_<key>.
 *
 * PostgreSQL-only mode: the API key is scoped to a specific user.
 */

import { NextRequest, NextResponse } from "next/server";
import { validateApiKey } from "@/lib/api-auth";
import type { AuthStrategy, AuthResult } from "../strategy";

export class ApiKeyStrategy implements AuthStrategy {
  readonly method = "api_key" as const;

  async authenticate(request: NextRequest): Promise<AuthResult> {
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
