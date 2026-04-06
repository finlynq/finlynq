/**
 * /api/transactions/splits — CRUD for transaction splits
 *
 * GET    ?transactionId=N  → list splits for a transaction
 * POST                     → create/replace all splits for a transaction
 * DELETE ?transactionId=N  → delete all splits for a transaction
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/require-auth";
import { db } from "@/db";
import { transactionSplits, transactions } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { validateBody, safeErrorMessage } from "@/lib/validate";

const splitSchema = z.object({
  categoryId: z.number().nullable().optional(),
  amount: z.number(),
  note: z.string().optional(),
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

  const transactionId = Number(request.nextUrl.searchParams.get("transactionId"));
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
    .all();

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
      amount: s.amount,
      note: s.note ?? "",
    }));

    const inserted = await db.insert(transactionSplits).values(rows).returning().all();
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
