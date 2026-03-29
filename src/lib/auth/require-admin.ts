/**
 * Admin auth guard — ensures the requesting user has role "admin".
 *
 * Usage in API routes:
 *   const auth = await requireAdmin(request);
 *   if (!auth.authenticated) return auth.response;
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "./require-auth";
import { getUserById } from "./queries";

export async function requireAdmin(request: NextRequest) {
  const authResult = await requireAuth(request);
  if (!authResult.authenticated) {
    return authResult;
  }

  const user = getUserById(authResult.context.userId);
  if (!user || user.role !== "admin") {
    return {
      authenticated: false as const,
      response: NextResponse.json(
        { error: "Admin access required." },
        { status: 403 }
      ),
    };
  }

  return authResult;
}
