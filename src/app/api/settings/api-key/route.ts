import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { getDEK } from "@/lib/crypto/dek-cache";
import { getOrCreateApiKey, regenerateApiKey } from "@/lib/api-auth";

/**
 * GET /api/settings/api-key â€” returns (or generates) the user's API key.
 *
 * Keys are stored hashed, so the raw key is returned **only** on first
 * creation (`apiKey` is a string once and only once, then `null` on every
 * subsequent GET). The UI must prompt the user to copy it immediately and
 * offer regeneration if they've lost it.
 *
 * Reading doesn't need a DEK. If a DEK is available it's wrapped on first
 * creation so Bearer-auth MCP requests can unwrap without a live session;
 * if not, the user can regenerate later to attach one.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId, sessionId } = auth.context;
  const dek = sessionId ? getDEK(sessionId, userId) : undefined;

  const apiKey = await getOrCreateApiKey(userId, dek ?? undefined);
  return NextResponse.json({
    apiKey,                    // raw key on first creation, null thereafter
    hasKey: true,              // getOrCreateApiKey always ensures one exists
    hasDekWrap: Boolean(dek),
  });
}

/**
 * POST /api/settings/api-key â€” regenerates the user's API key + DEK wrap.
 * Regeneration must attach a DEK wrap, so this path requires the DEK.
 */
export async function POST(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;

  const apiKey = await regenerateApiKey(auth.userId, auth.dek);
  return NextResponse.json({ apiKey });
}
