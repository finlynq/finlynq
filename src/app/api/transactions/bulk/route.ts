/**
 * POST /api/transactions/bulk — bulk operations on transactions
 *
 * Body: { action, ids, ...params }
 *
 * Actions:
 *   delete              — delete all transactions in ids[]
 *   update_category     — set categoryId for all ids[]
 *   update_account      — set accountId for all ids[]
 *   update_date         — set date for all ids[]
 *   update_note         — set note for all ids[]
 *   update_payee        — set payee for all ids[]
 *   update_tags         — set tags for all ids[]
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/require-auth";
import { db, schema } from "@/db";
import { and, eq, inArray } from "drizzle-orm";
import { validateBody, safeErrorMessage } from "@/lib/validate";

const { transactions } = schema;

const bulkSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("delete"),
    ids: z.array(z.number()).min(1),
  }),
  z.object({
    action: z.literal("update_category"),
    ids: z.array(z.number()).min(1),
    categoryId: z.number(),
  }),
  z.object({
    action: z.literal("update_account"),
    ids: z.array(z.number()).min(1),
    accountId: z.number(),
  }),
  z.object({
    action: z.literal("update_date"),
    ids: z.array(z.number()).min(1),
    date: z.string(),
  }),
  z.object({
    action: z.literal("update_note"),
    ids: z.array(z.number()).min(1),
    note: z.string(),
  }),
  z.object({
    action: z.literal("update_payee"),
    ids: z.array(z.number()).min(1),
    payee: z.string(),
  }),
  z.object({
    action: z.literal("update_tags"),
    ids: z.array(z.number()).min(1),
    tags: z.string(),
  }),
]);

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;

  const { userId } = auth.context;

  try {
    const body = await request.json();
    const parsed = validateBody(body, bulkSchema);
    if (parsed.error) return parsed.error;

    const { action, ids } = parsed.data;

    // All operations are scoped to the user's own transactions
    switch (action) {
      case "delete":
        await db
          .delete(transactions)
          .where(and(inArray(transactions.id, ids), eq(transactions.userId, userId)))
          ;
        break;

      case "update_category":
        await db
          .update(transactions)
          .set({ categoryId: parsed.data.categoryId })
          .where(and(inArray(transactions.id, ids), eq(transactions.userId, userId)))
          ;
        break;

      case "update_account":
        await db
          .update(transactions)
          .set({ accountId: parsed.data.accountId })
          .where(and(inArray(transactions.id, ids), eq(transactions.userId, userId)))
          ;
        break;

      case "update_date":
        await db
          .update(transactions)
          .set({ date: parsed.data.date })
          .where(and(inArray(transactions.id, ids), eq(transactions.userId, userId)))
          ;
        break;

      case "update_note":
        await db
          .update(transactions)
          .set({ note: parsed.data.note })
          .where(and(inArray(transactions.id, ids), eq(transactions.userId, userId)))
          ;
        break;

      case "update_payee":
        await db
          .update(transactions)
          .set({ payee: parsed.data.payee })
          .where(and(inArray(transactions.id, ids), eq(transactions.userId, userId)))
          ;
        break;

      case "update_tags":
        await db
          .update(transactions)
          .set({ tags: parsed.data.tags })
          .where(and(inArray(transactions.id, ids), eq(transactions.userId, userId)))
          ;
        break;
    }

    return NextResponse.json({ success: true, affected: ids.length });
  } catch (error) {
    return NextResponse.json(
      { error: safeErrorMessage(error, "Bulk operation failed") },
      { status: 500 }
    );
  }
}
