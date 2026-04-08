import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { getOrCreateApiKey } from "@/lib/api-auth";

/** GET /api/settings/api-key — returns (or generates) the user's API key */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;

  const apiKey = await getOrCreateApiKey();
  return NextResponse.json({ apiKey });
}
