import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { getOrCreateApiKey, regenerateApiKey } from "@/lib/api-auth";

/** GET /api/settings/api-key — returns (or generates) the user's API key */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;

  const apiKey = await getOrCreateApiKey(auth.context.userId);
  return NextResponse.json({ apiKey });
}

/** POST /api/settings/api-key — regenerates the user's API key */
export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;

  const apiKey = await regenerateApiKey(auth.context.userId);
  return NextResponse.json({ apiKey });
}
