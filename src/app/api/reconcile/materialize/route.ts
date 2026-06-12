/**
 * POST /api/reconcile/materialize
 *
 * Body: { bankTransactionId: string, categoryId?: number, accountId?: number }
 *
 * Creates a fresh `transactions` row mirrored from an existing
 * `bank_transactions` row + inserts a 'primary' `transaction_bank_links` row.
 *
 * Use case: the user is on the reconcile page, sees a "bank-only" row
 * (bank ledger has it; no corresponding transaction — usually because the
 * user deleted the tx earlier or rejected the staged row), and wants to
 * materialize it as a real transaction. The new tx's lineage FK and the
 * join row are both set so the row stops being "bank-only" on next load.
 *
 * FINLYNQ-150 — the materialize logic now lives in the shared lib
 * `materializeBankRowAsTransaction()` so this route AND the
 * `materialize_bank_row` MCP tool share one chokepoint (the six load-bearing
 * invariants are documented there). This POST is a thin adapter: parse body →
 * call the fn → map typed `{ok:false,code}` to the EXACT statuses + bodies the
 * web client already depends on. External HTTP contract preserved byte-for-byte:
 *   - `*_not_found`                 → 404 `{error:"Not found"}`
 *   - `investment_account_unsupported` → 400 `{error, code}`
 *   - `sign_category_mismatch`      → 400 `{error, code}`
 *   - success                       → `{success:true,data:{transactionId}}`
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { validateBody } from "@/lib/validate";
import { materializeBankRowAsTransaction } from "@/lib/reconcile/materialize-transaction";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  bankTransactionId: z.string().uuid(),
  categoryId: z.number().int().positive().optional(),
  accountId: z.number().int().positive().optional(),
});

export async function POST(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const { userId, dek } = auth;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = validateBody(body, bodySchema);
  if (parsed.error) return parsed.error;

  const result = await materializeBankRowAsTransaction({
    userId,
    dek,
    bankTransactionId: parsed.data.bankTransactionId,
    categoryId: parsed.data.categoryId,
    accountId: parsed.data.accountId,
  });

  if (!result.ok) {
    switch (result.code) {
      case "bank_not_found":
      case "account_not_found":
      case "category_not_found":
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      case "investment_account_unsupported":
      case "sign_category_mismatch":
        return NextResponse.json(
          { error: result.message, code: result.code },
          { status: 400 },
        );
    }
  }

  return NextResponse.json({
    success: true,
    data: { transactionId: result.transactionId },
  });
}
