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
import { requireEncryption } from "@/lib/auth/require-encryption";
import { encryptField } from "@/lib/crypto/envelope";
import { invalidateUser as invalidateUserTxCache } from "@/lib/mcp/user-tx-cache";
import { db, schema } from "@/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { validateBody, safeErrorMessage } from "@/lib/validate";
import { verifyOwnership, OwnershipError } from "@/lib/verify-ownership";

const { transactions } = schema;

// Issue #28: every UPDATE site bumps updated_at = NOW() so the audit
// timestamp reflects the row's last mutation. Hoisted into a constant so
// re-using it in each switch arm reads as one chokepoint.
const AUDIT_BUMP = { updatedAt: sql`NOW()` } as const;

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
  // Parse the body once so we can pick the right auth guard. Text-field
  // actions need the DEK; ID/number-only actions don't.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = validateBody(body, bulkSchema);
  if (parsed.error) return parsed.error;

  const needsDek =
    parsed.data.action === "update_note" ||
    parsed.data.action === "update_payee" ||
    parsed.data.action === "update_tags";

  let userId: string;
  let dek: Buffer | null = null;
  if (needsDek) {
    const encAuth = await requireEncryption(request);
    if (!encAuth.ok) return encAuth.response;
    userId = encAuth.userId;
    dek = encAuth.dek;
  } else {
    const baseAuth = await requireAuth(request);
    if (!baseAuth.authenticated) return baseAuth.response;
    userId = baseAuth.context.userId;
  }

  try {
    const { action, ids } = parsed.data;

    // Cross-tenant FK guard (H-1) — `update_category` and `update_account`
    // re-point the FK on every selected row. Without verification, the new
    // FK could belong to another user, attaching their account/category to
    // the caller's transactions on every aggregator/report.
    if (action === "update_category") {
      await verifyOwnership(userId, { categoryIds: [parsed.data.categoryId] });
    } else if (action === "update_account") {
      await verifyOwnership(userId, { accountIds: [parsed.data.accountId] });
    }

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
          .set({ categoryId: parsed.data.categoryId, ...AUDIT_BUMP })
          .where(and(inArray(transactions.id, ids), eq(transactions.userId, userId)))
          ;
        break;

      case "update_account":
        await db
          .update(transactions)
          .set({ accountId: parsed.data.accountId, ...AUDIT_BUMP })
          .where(and(inArray(transactions.id, ids), eq(transactions.userId, userId)))
          ;
        break;

      case "update_date":
        await db
          .update(transactions)
          .set({ date: parsed.data.date, ...AUDIT_BUMP })
          .where(and(inArray(transactions.id, ids), eq(transactions.userId, userId)))
          ;
        break;

      case "update_note":
        await db
          .update(transactions)
          .set({ note: encryptField(dek!, parsed.data.note), ...AUDIT_BUMP })
          .where(and(inArray(transactions.id, ids), eq(transactions.userId, userId)))
          ;
        break;

      case "update_payee":
        await db
          .update(transactions)
          .set({ payee: encryptField(dek!, parsed.data.payee), ...AUDIT_BUMP })
          .where(and(inArray(transactions.id, ids), eq(transactions.userId, userId)))
          ;
        break;

      case "update_tags":
        await db
          .update(transactions)
          .set({ tags: encryptField(dek!, parsed.data.tags), ...AUDIT_BUMP })
          .where(and(inArray(transactions.id, ids), eq(transactions.userId, userId)))
          ;
        break;
    }

    invalidateUserTxCache(userId);
    return NextResponse.json({ success: true, affected: ids.length });
  } catch (error) {
    if (error instanceof OwnershipError) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(
      { error: safeErrorMessage(error, "Bulk operation failed") },
      { status: 500 }
    );
  }
}
