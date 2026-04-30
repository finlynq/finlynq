import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { commitReconcile, MAX_RECONCILE_ROWS } from "@/lib/reconcile";
import { logApiError, safeErrorMessage, validateBody } from "@/lib/validate";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 8 * 1024 * 1024;

const approvedRowSchema = z.object({
  rowIndex: z.number().int().min(0),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"),
  accountId: z.number().int().positive(),
  amount: z.number().finite(),
  payee: z.string().max(500).default(""),
  categoryId: z.number().int().positive().nullable().optional(),
  currency: z.string().min(1).max(10).optional(),
  enteredAmount: z.number().finite().optional(),
  enteredCurrency: z.string().min(1).max(10).optional(),
  note: z.string().max(2000).optional(),
  tags: z.string().max(2000).optional(),
  quantity: z.number().finite().optional(),
  portfolioHoldingId: z.number().int().positive().nullable().optional(),
  fitId: z.string().max(200).optional(),
  linkId: z.string().max(64).optional(),
});

const bodySchema = z.object({
  rows: z.array(approvedRowSchema).min(1).max(MAX_RECONCILE_ROWS),
  /** Tracks user intent — server still re-classifies, but the explicit flag
   *  forces commit on PROBABLE_DUPLICATE rows so the client can't accept
   *  them by accident. */
  acceptProbableDuplicates: z.boolean().optional(),
});

/**
 * Reconcile-mode commit (issue #36). Atomic — single `db.transaction()`
 * around the INSERT batch, so partial failures roll back fully.
 *
 * The classifier already ran in /preview; the client returns the user's
 * approved subset (post-edit). This endpoint trusts the client's row
 * selection but re-validates account ownership + investment-account
 * holding constraint inside the lib before opening the transaction.
 */
export async function POST(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const { userId, dek } = auth;

  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: `Request body exceeds ${MAX_BODY_BYTES} byte limit` },
      { status: 413 },
    );
  }

  try {
    const body = await request.json();
    const parsed = validateBody(body, bodySchema);
    if (parsed.error) return parsed.error;

    const result = await commitReconcile(userId, dek, parsed.data.rows);
    if (result.errors.length > 0 && result.imported === 0) {
      return NextResponse.json(result, { status: 400 });
    }
    return NextResponse.json(result);
  } catch (error) {
    await logApiError("POST", "/api/import/reconcile/commit", error, userId);
    const message = safeErrorMessage(error, "Reconcile commit failed");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
