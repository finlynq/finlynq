/**
 * GET/PUT /api/accounts/[id]/opening-balance — FINLYNQ-206
 *
 * The opening balance is a single-source-of-truth field backed ENTIRELY by one
 * `kind='opening_balance'` transaction (no `accounts` column). See
 * src/lib/accounts/opening-balance.ts for the model.
 *
 *   GET → { success: true, data: { transactionId, amount, date } | null }
 *         (requireAuth — amount/date are plaintext columns; null when unset)
 *
 *   PUT  body { amount: number | null, date?: "YYYY-MM-DD" }
 *        → { success: true, data: <OpeningBalance | null> }
 *        requireEncryption (the created row's payee is DEK-encrypted).
 *        amount null/empty/0 ZEROES the existing row (never deletes); cash
 *        accounts only (investment → 400).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { safeErrorMessage } from "@/lib/validate";
import { isReasonableAmount } from "@/lib/utils/number";
import {
  getOpeningBalance,
  setOpeningBalance,
  OpeningBalanceInvestmentError,
  OpeningBalanceAccountNotFoundError,
} from "@/lib/accounts/opening-balance";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;

  const id = Number((await params).id);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "Invalid account id" }, { status: 400 });
  }

  try {
    const data = await getOpeningBalance(userId, id);
    return NextResponse.json({ success: true, data });
  } catch (err) {
    return NextResponse.json(
      { error: safeErrorMessage(err, "Failed to read opening balance") },
      { status: 500 },
    );
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const { userId, dek } = auth;

  const id = Number((await params).id);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "Invalid account id" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const rawAmount = (body as { amount?: unknown } | null)?.amount;
  const rawDate = (body as { date?: unknown } | null)?.date;

  // amount: number | null. null / "" → clear (zero the row, never delete).
  let amount: number | null;
  if (rawAmount == null || rawAmount === "") {
    amount = null;
  } else {
    const n = typeof rawAmount === "number" ? rawAmount : Number(rawAmount);
    if (!Number.isFinite(n) || !isReasonableAmount(n)) {
      return NextResponse.json(
        { error: "amount must be a finite, reasonable number" },
        { status: 400 },
      );
    }
    amount = n;
  }

  const date =
    typeof rawDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(rawDate)
      ? rawDate
      : undefined;

  try {
    const data = await setOpeningBalance(userId, id, dek, { amount, date });
    return NextResponse.json({ success: true, data });
  } catch (err) {
    if (err instanceof OpeningBalanceInvestmentError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof OpeningBalanceAccountNotFoundError) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(
      { error: safeErrorMessage(err, "Failed to update opening balance") },
      { status: 500 },
    );
  }
}
