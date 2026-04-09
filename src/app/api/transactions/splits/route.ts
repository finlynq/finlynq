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
import { db, schema } from "@/db";
import { eq, and, inArray } from "drizzle-orm";
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
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;

  const transactionIdParam = request.nextUrl.searchParams.get("transactionId");

  // Return all splits for the user (used by export)
  if (!transactionIdParam) {
    const userTxnIds = await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(eq(transactions.userId, auth.context.userId))
      ;
    const ids = userTxnIds.map((t) => t.id);
    if (ids.length === 0) return NextResponse.json([]);
    const splits = await db
      .select()
      .from(transactionSplits)
      .where(inArray(transactionSplits.transactionId, ids))
      ;
    return NextResponse.json(splits);
  }

  const transactionId = Number(transactionIdParam);
  if (!transactionId) {
    return NextResponse.json({ error: "transactionId is required" }, { status: 400 });
  }

  if (!(await assertTxnOwnership(transactionId, auth.context.userId))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const splits = await db
    .select()
    .from(transactionSplits)
    .where(eq(transactionSplits.transactionId, transactionId))
    ;

  return NextResponse.json(splits);
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;

  try {
    const body = await request.json();
    const parsed = validateBody(body, postSchema);
    if (parsed.error) return parsed.error;

    const { transactionId, splits } = parsed.data;

    if (!(await assertTxnOwnership(transactionId, auth.context.userId))) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Replace existing splits atomically
    await db.delete(transactionSplits).where(eq(transactionSplits.transactionId, transactionId)).run();

    const rows = splits.map((s) => ({
      transactionId,
      categoryId: s.categoryId ?? null,
      accountId: s.accountId ?? null,
      amount: s.amount,
      note: s.note ?? "",
      description: s.description ?? "",
      tags: s.tags ?? "",
    }));

    const inserted = await db.insert(transactionSplits).values(rows).returning();
    return NextResponse.json(inserted, { status: 201 });
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

  await db.delete(transactionSplits).where(eq(transactionSplits.transactionId, transactionId)).run();
  return NextResponse.json({ success: true });
}
