/**
 * /api/transactions/splits — CRUD for transaction splits
 *
 * GET    ?transactionId=N  → list splits for a transaction
 * GET    (no params)        → list ALL splits for the user (for export)
 * POST                     → create/replace all splits for a transaction
 * DELETE ?transactionId=N  → delete all splits for a transaction
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/require-auth";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { getDEK } from "@/lib/crypto/dek-cache";
import {
  encryptSplitWrite,
  decryptSplitRows,
} from "@/lib/crypto/encrypted-columns";
import { invalidateUser as invalidateUserTxCache } from "@/lib/mcp/user-tx-cache";
import { db, schema } from "@/db";
import { eq, and, inArray, sql } from "drizzle-orm";
import { validateBody, safeErrorMessage } from "@/lib/validate";

const { transactionSplits, transactions } = schema;

const splitSchema = z.object({
  categoryId: z.number().nullable().optional(),
  accountId: z.number().nullable().optional(),
  amount: z.number(),
  note: z.string().optional(),
  description: z.string().optional(),
  tags: z.string().optional(),
});

const postSchema = z.object({
  transactionId: z.number(),
  splits: z.array(splitSchema).min(1),
});

/** Verify the transaction belongs to the requesting user */
async function assertTxnOwnership(transactionId: number, userId: string): Promise<boolean> {
  const txn = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(and(eq(transactions.id, transactionId), eq(transactions.userId, userId)))
    .get();
  return !!txn;
}

export async function GET(request: NextRequest) {
  // Reads degrade gracefully — without a DEK, encrypted split rows ship
  // as `v1:` ciphertext rather than 423-ing the transactions page.
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId, sessionId } = auth.context;
  const dek = sessionId ? getDEK(sessionId) : null;

  const transactionIdParam = request.nextUrl.searchParams.get("transactionId");

  // Return all splits for the user (used by export)
  if (!transactionIdParam) {
    const userTxnIds = await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(eq(transactions.userId, userId))
      .all();
    const ids = userTxnIds.map((t) => t.id);
    if (ids.length === 0) return NextResponse.json([]);
    const splits = await db
      .select()
      .from(transactionSplits)
      .where(inArray(transactionSplits.transactionId, ids))
      .all();
    return NextResponse.json(decryptSplitRows(dek, splits));
  }

  const transactionId = Number(transactionIdParam);
  if (!transactionId) {
    return NextResponse.json({ error: "transactionId is required" }, { status: 400 });
  }

  if (!(await assertTxnOwnership(transactionId, userId))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const splits = await db
    .select()
    .from(transactionSplits)
    .where(eq(transactionSplits.transactionId, transactionId))
    .all();

  return NextResponse.json(decryptSplitRows(dek, splits));
}

export async function POST(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const { userId, dek } = auth;

  try {
    const body = await request.json();
    const parsed = validateBody(body, postSchema);
    if (parsed.error) return parsed.error;

    const { transactionId, splits } = parsed.data;

    if (!(await assertTxnOwnership(transactionId, userId))) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Pull parent's currency context so each split inherits the entered_*
    // trilogy. Splits don't accept their own entered_* from the client —
    // they're derived from the parent's locked rate so the split sums match
    // the parent's entered amount.
    const parent = await db
      .select({
        amount: transactions.amount,
        currency: transactions.currency,
        enteredAmount: transactions.enteredAmount,
        enteredCurrency: transactions.enteredCurrency,
        enteredFxRate: transactions.enteredFxRate,
      })
      .from(transactions)
      .where(eq(transactions.id, transactionId))
      .get();

    const parentCurrency = parent?.currency ?? "CAD";
    const parentEnteredCurrency = parent?.enteredCurrency ?? parentCurrency;
    const parentEnteredFxRate = parent?.enteredFxRate ?? 1;
    const sameCurrency = parentEnteredCurrency.toUpperCase() === parentCurrency.toUpperCase();
    const round2 = (n: number) => Math.round(n * 100) / 100;

    // Replace existing splits atomically
    await db.delete(transactionSplits).where(eq(transactionSplits.transactionId, transactionId));

    const rows = splits.map((s) => {
      const encrypted = encryptSplitWrite(dek, {
        note: s.note ?? "",
        description: s.description ?? "",
        tags: s.tags ?? "",
      });
      // amount = account-currency value; entered_* mirror the parent.
      // For cross-currency parents, invert the locked rate to get the
      // user-typed (entered) amount: entered = amount / enteredFxRate.
      const enteredAmount = sameCurrency || !parentEnteredFxRate
        ? s.amount
        : round2(s.amount / parentEnteredFxRate);
      return {
        transactionId,
        categoryId: s.categoryId ?? null,
        accountId: s.accountId ?? null,
        amount: s.amount,
        enteredAmount,
        enteredCurrency: parentEnteredCurrency,
        enteredFxRate: parentEnteredFxRate,
        note: encrypted.note ?? "",
        description: encrypted.description ?? "",
        tags: encrypted.tags ?? "",
      };
    });

    const inserted = await db.insert(transactionSplits).values(rows).returning().all();
    // Issue #28: splits are part of the parent transaction's logical state,
    // so a (re)split bumps the parent's updated_at. Lets "recently modified"
    // sorts and the edit-dialog footer reflect split edits even though
    // splits live on their own table.
    await db
      .update(transactions)
      .set({ updatedAt: sql`NOW()` })
      .where(and(eq(transactions.id, transactionId), eq(transactions.userId, userId)));
    invalidateUserTxCache(userId);
    return NextResponse.json(decryptSplitRows(dek, inserted), { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to save splits") },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;

  const transactionId = Number(request.nextUrl.searchParams.get("transactionId"));
  if (!transactionId) {
    return NextResponse.json({ error: "transactionId is required" }, { status: 400 });
  }

  if (!(await assertTxnOwnership(transactionId, auth.context.userId))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await db.delete(transactionSplits).where(eq(transactionSplits.transactionId, transactionId));
  // Issue #28: clearing splits is also a logical mutation of the parent.
  await db
    .update(transactions)
    .set({ updatedAt: sql`NOW()` })
    .where(and(eq(transactions.id, transactionId), eq(transactions.userId, auth.context.userId)));
  invalidateUserTxCache(auth.context.userId);
  return NextResponse.json({ success: true });
}
