import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { getDEK } from "@/lib/crypto/dek-cache";
import { getOrCreateApiKey, regenerateApiKey } from "@/lib/api-auth";

/**
 * GET /api/settings/api-key — returns (or generates) the user's API key.
 *
 * Reading an existing key doesn't need a DEK. If the user has no key yet,
 * one is created; when a DEK is available it's wrapped so Bearer-auth MCP
 * requests can unwrap without a live session. If no DEK is available
 * (session cache missed), the key is still returned but without a DEK
 * wrap — the user can regenerate later to attach one.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId, sessionId } = auth.context;
  const dek = sessionId ? getDEK(sessionId) : undefined;

  const apiKey = await getOrCreateApiKey(userId, dek ?? undefined);
  return NextResponse.json({ apiKey, hasDekWrap: Boolean(dek) });
}

/**
 * POST /api/settings/api-key — regenerates the user's API key + DEK wrap.
 * Regeneration must attach a DEK wrap, so this path requires the DEK.
 */
export async function POST(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;

  const apiKey = await regenerateApiKey(auth.userId, auth.dek);
  return NextResponse.json({ apiKey });
}
