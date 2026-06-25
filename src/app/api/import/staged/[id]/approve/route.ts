/**
 * POST /api/import/staged/[id]/approve
 *
 * Phase 3 of import-modes refactor (2026-05-25). Per
 * [plan/import-modes-simplified-detailed.md](../../../../../plan/import-modes-simplified-detailed.md).
 *
 * Approve is now a one-job route: promote the selected staged rows into
 * `bank_transactions`. No more categorization gate, no transactions write,
 * no transaction_bank_links insert (except legacy linked rows), no
 * transfer-pair classification, no executeImport. `/reconcile` is the single
 * decision surface for categorization + linking + transfer pairing.
 *
 * FINLYNQ-220 (R-07, 2026-06-24): the bank-only promote logic was DRY-extracted
 * into the shared `sendStagedRowsToBankLedger` chokepoint
 * ([src/lib/import/send-to-bank-ledger.ts]) so the MCP `send_to_bank_ledger`
 * tool and this route share ONE implementation (mirrors the FINLYNQ-150
 * `materializeBankRowAsTransaction` pattern). This route passes
 * `skipExistingMatches: false` to stay byte-identical to its pre-extraction
 * behavior; the MCP tool defaults it `true`.
 *
 * Body (all optional):
 *   {
 *     "rowIds":             string[]   // subset of staged_transactions.id; omit = all eligible
 *   }
 *
 * Returns:
 *   { success, batchId, approved, skippedDuplicates, legacyLinked,
 *     anchorsPromoted, balanceWarnings, redirectTo, rowErrors }
 *
 * Load-bearing rules (CLAUDE.md) — now enforced inside the shared helper:
 *   - import_hash over PLAINTEXT payee, recomputed with the resolved accountId.
 *   - Encryption tier per row branches at decode time.
 *   - Bank-ledger sources strict subset: 'import' for upload + email paths.
 *   - validateBankBalances stays — warn-but-allow on divergence.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { sendStagedRowsToBankLedger } from "@/lib/import/send-to-bank-ledger";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const { userId, dek } = auth;
  const { id } = await params;

  // Body is optional — default = approve everything eligible.
  let rowIds: string[] | undefined;
  try {
    const body = await request.json() as { rowIds?: unknown };
    if (Array.isArray(body.rowIds)) {
      rowIds = body.rowIds.filter((x): x is string => typeof x === "string");
    }
  } catch {
    // no body / invalid JSON → approve everything
  }

  const result = await sendStagedRowsToBankLedger({
    userId,
    dek,
    stagedImportId: id,
    rowIds,
    // Web route preserves its pre-FINLYNQ-220 behavior — never drop
    // dedup_status='existing' rows up front (the MCP tool defaults this true).
    skipExistingMatches: false,
  });

  if (!result.ok) {
    // The only refusal codes are ownership/empty-selection → 404, mirroring
    // the pre-extraction "Not found or already processed" / "No rows selected"
    // statuses. (The route previously returned 400 for "No rows selected";
    // both collapse to the helper's not_found code. Surface 404 for both —
    // a missing import and an empty selection are both terminal for the UI.)
    const status = result.message === "No rows selected" ? 400 : 404;
    return NextResponse.json({ error: result.message }, { status });
  }

  return NextResponse.json({
    success: true,
    batchId: result.batchId,
    approved: result.approved,
    skippedDuplicates: result.skippedDuplicates,
    legacyLinked: result.legacyLinked,
    anchorsPromoted: result.anchorsPromoted,
    balanceWarnings: result.balanceWarnings,
    rowErrors: result.rowErrors,
    redirectTo: result.boundAccountId != null
      ? `/reconcile?account=${result.boundAccountId}`
      : "/reconcile",
  });
}
