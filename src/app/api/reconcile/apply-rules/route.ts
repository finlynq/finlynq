/**
 * POST /api/reconcile/apply-rules — apply the user's transaction rules to a set
 * of bank-ledger rows on demand (FINLYNQ-208).
 *
 * Web parity of the MCP `apply_rules_to_bank_rows` tool: a thin adapter over the
 * shared `applyRulesToBankRows` chokepoint with `autoMaterialize=true`, so a
 * matched rule materializes immediately — including the FINLYNQ-208
 * `record_investment_op` action (which the chokepoint runs through
 * `materializeBankRowAsPortfolioOp`, lifting the investment-account guard).
 *
 * Drives the reconcile surface's "Apply rules" affordance + the per-row
 * investment "Create" action. Ownership is enforced inside the chokepoint (every
 * bank row SELECT filters on `userId`), so cross-tenant ids are silently
 * dropped. `requireEncryption` — materialize writes the user-tier ledger.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { validateBody, safeErrorMessage, logApiError } from "@/lib/validate";
import { applyRulesToBankRows } from "@/lib/reconcile/match-engine";

const bodySchema = z.object({
  /** bank_transactions UUIDs to apply rules to. Already-linked / possible-
   *  duplicate rows are skipped by the chokepoint. */
  bankRowIds: z.array(z.string().min(1)).min(1).max(500),
});

export async function POST(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  try {
    const body = await request.json();
    const parsed = validateBody(body, bodySchema);
    if (parsed.error) return parsed.error;

    const result = await applyRulesToBankRows(
      auth.userId,
      parsed.data.bankRowIds,
      auth.dek,
      { autoMaterialize: true },
    );

    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    await logApiError("POST", "/api/reconcile/apply-rules", err, auth.userId);
    return NextResponse.json(
      { error: safeErrorMessage(err, "Failed to apply rules") },
      { status: 500 },
    );
  }
}
