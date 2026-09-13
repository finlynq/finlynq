import { NextRequest, NextResponse } from "next/server";
import { requireEncryption } from "@/lib/auth/require-encryption";
import {
  syncSimpleFin,
  SimplefinNotConnectedError,
  type SimplefinAccountChoice,
} from "@/lib/external-import/simplefin-orchestrator";
import { simplefin } from "@finlynq/import-connectors";

/**
 * POST /api/settings/bank-feeds/simplefin/sync
 *
 * Body: { choices?: Record<simplefinAccountId, {mode:"existing",accountId} |
 * {mode:"create"}> }. Resolves each new account's create/link decision, then
 * STAGES the last ~90 days into per-account `staged_imports` rows
 * (source='connector') for review at /import/pending. Already-mapped accounts
 * sync without a choice. requireEncryption — needs the DEK to stage under the
 * user key. No `transactions` rows are created here (approve at /import/pending
 * promotes to bank_transactions for reconciliation).
 */
export async function POST(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;

  let choices: Record<string, SimplefinAccountChoice> = {};
  try {
    const body = await request.json();
    if (body && typeof body.choices === "object" && body.choices !== null) {
      choices = body.choices as Record<string, SimplefinAccountChoice>;
    }
  } catch {
    // No body / invalid JSON — treat as no choices (re-sync of mapped accounts).
  }

  try {
    const result = await syncSimpleFin(auth.userId, auth.dek, choices);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof SimplefinNotConnectedError) {
      return NextResponse.json({ error: "SimpleFIN is not connected" }, { status: 400 });
    }
    if (err instanceof simplefin.SimpleFinApiError) {
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    console.error("[simplefin/sync] failed", err);
    return NextResponse.json({ error: "Sync failed" }, { status: 500 });
  }
}
