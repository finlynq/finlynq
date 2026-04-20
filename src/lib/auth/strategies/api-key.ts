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

    // `dek` is populated when the API key was created/regenerated with an
    // envelope wrap (logged-in flow). Legacy API keys (from before the
    // encryption rollout) validate successfully but carry null DEK; the
    // caller should prompt the user to regenerate the key in settings.
    //
    // sessionId is synthesized from the key-value pair so each key gets a
    // unique identity for rate-limiting or audit logging without exposing
    // the key itself.
    return {
      authenticated: true,
      context: {
        userId: result.userId,
        method: "api_key",
        mfaVerified: false,
        dek: result.dek,
        sessionId: `apikey:${result.userId}`,
      },
    };
  }
}
