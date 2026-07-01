import { NextRequest, NextResponse } from "next/server";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { connectSimpleFin } from "@/lib/external-import/simplefin-orchestrator";
import { simplefin } from "@finlynq/import-connectors";

/**
 * POST /api/settings/bank-feeds/simplefin/connect
 *
 * Body: { setupToken }. Exchanges the one-time SimpleFIN setup token for a
 * long-lived access URL and stores it encrypted under the user's DEK.
 * requireEncryption (423 if no DEK) — the access URL is written under the DEK.
 */
export async function POST(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;

  let body: { setupToken?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const setupToken = typeof body.setupToken === "string" ? body.setupToken.trim() : "";
  if (!setupToken) {
    return NextResponse.json({ error: "Setup token is required" }, { status: 400 });
  }

  try {
    const result = await connectSimpleFin(auth.userId, auth.dek, setupToken);
    return NextResponse.json(result);
  } catch (err) {
    // Bad / expired setup token — a user-fixable input error, never a 500.
    if (err instanceof simplefin.SimpleFinSetupTokenError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error("[simplefin/connect] failed", err);
    return NextResponse.json({ error: "Failed to connect SimpleFIN" }, { status: 500 });
  }
}
