import { NextRequest, NextResponse } from "next/server";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { getOrCreateApiKey, regenerateApiKey } from "@/lib/api-auth";

/**
 * GET /api/settings/api-key — returns (or generates) the user's API key.
 *
 * If the user has no key yet, one is created AND its envelope wrap of the
 * DEK is stored so future Bearer auth can unwrap without a session.
 */
export async function GET(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;

  const apiKey = await getOrCreateApiKey(auth.userId, auth.dek);
  return NextResponse.json({ apiKey });
}

/** POST /api/settings/api-key — regenerates the user's API key + DEK wrap. */
export async function POST(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;

  const apiKey = await regenerateApiKey(auth.userId, auth.dek);
  return NextResponse.json({ apiKey });
}
