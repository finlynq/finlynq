import { NextRequest, NextResponse } from "next/server";
import { and, eq, ne } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireAuth } from "@/lib/auth/require-auth";
import { getDEK } from "@/lib/crypto/dek-cache";
import { decryptTxRows } from "@/lib/crypto/encrypted-columns";

/**
 * GET /api/transactions/linked?linkId=<id>&excludeId=<txId>
 *
 * Returns the sibling transactions sharing a `link_id` — the "other legs"
 * of a multi-leg import (transfer, same-account conversion, liquidation).
 * Scoped to the requesting user so a leaked link id can't surface another
 * tenant's rows.
 *
 * Follows the same soft-DEK policy as GET /api/transactions: if the in-
 * memory DEK cache is cold, encrypted columns come back as `v1:...` rather
 * than 423-ing — callers can still render account + amount + date.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId, sessionId } = auth.context;
  const dek = sessionId ? getDEK(sessionId) : null;

  const params = request.nextUrl.searchParams;
  const linkId = params.get("linkId");
  if (!linkId) {
    return NextResponse.json({ error: "Missing linkId" }, { status: 400 });
  }
  const excludeIdRaw = params.get("excludeId");
  const excludeId = excludeIdRaw ? parseInt(excludeIdRaw) : null;

  const conditions = [
    eq(schema.transactions.userId, userId),
    eq(schema.transactions.linkId, linkId),
  ];
  if (excludeId) conditions.push(ne(schema.transactions.id, excludeId));

  const rows = await db
    .select({
      id: schema.transactions.id,
      date: schema.transactions.date,
      accountId: schema.transactions.accountId,
      accountName: schema.accounts.name,
      categoryId: schema.transactions.categoryId,
      categoryName: schema.categories.name,
      currency: schema.transactions.currency,
      amount: schema.transactions.amount,
      quantity: schema.transactions.quantity,
      portfolioHolding: schema.transactions.portfolioHolding,
      note: schema.transactions.note,
      payee: schema.transactions.payee,
      tags: schema.transactions.tags,
      linkId: schema.transactions.linkId,
    })
    .from(schema.transactions)
    .leftJoin(schema.accounts, eq(schema.transactions.accountId, schema.accounts.id))
    .leftJoin(schema.categories, eq(schema.transactions.categoryId, schema.categories.id))
    .where(and(...conditions))
    .all();

  const decrypted = decryptTxRows(
    dek,
    rows as Array<Parameters<typeof decryptTxRows>[1][number]>,
  );
  return NextResponse.json({ data: decrypted });
}
