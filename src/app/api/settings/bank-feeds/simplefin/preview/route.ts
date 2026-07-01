import { NextRequest, NextResponse } from "next/server";
import { requireEncryption } from "@/lib/auth/require-encryption";
import {
  previewSimpleFin,
  SimplefinNotConnectedError,
} from "@/lib/external-import/simplefin-orchestrator";
import { simplefin } from "@finlynq/import-connectors";

/**
 * POST /api/settings/bank-feeds/simplefin/preview
 *
 * Fetches the SimpleFIN accounts and classifies each as mapped / suggested /
 * new so the UI can ask the user to create-or-link each new account before
 * staging. Read-only (no writes). requireEncryption — needs the DEK to decrypt
 * the stored access URL and the user's account names for suggestions.
 */
export async function POST(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;

  try {
    const preview = await previewSimpleFin(auth.userId, auth.dek);
    return NextResponse.json(preview);
  } catch (err) {
    if (err instanceof SimplefinNotConnectedError) {
      return NextResponse.json({ error: "SimpleFIN is not connected" }, { status: 400 });
    }
    if (err instanceof simplefin.SimpleFinApiError) {
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    console.error("[simplefin/preview] failed", err);
    return NextResponse.json({ error: "Failed to load accounts" }, { status: 500 });
  }
}
