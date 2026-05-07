import { NextRequest, NextResponse } from "next/server";
import { and, eq, ne } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireAuth } from "@/lib/auth/require-auth";
import { getDEK } from "@/lib/crypto/dek-cache";
import { decryptTxRows, decryptName } from "@/lib/crypto/encrypted-columns";
import { decryptField } from "@/lib/crypto/envelope";

/**
 * GET /api/transactions/linked?linkId=<id>&excludeId=<txId>
 *
 * Returns the sibling transactions sharing a `link_id` â€” the "other legs"
 * of a multi-leg import (transfer, same-account conversion, liquidation).
 * Scoped to the requesting user so a leaked link id can't surface another
 * tenant's rows.
 *
 * Follows the same soft-DEK policy as GET /api/transactions: if the in-
 * memory DEK cache is cold, encrypted columns come back as `v1:...` rather
 * than 423-ing â€” callers can still render account + amount + date.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId, sessionId } = auth.context;
  const dek = sessionId ? getDEK(sessionId, userId) : null;

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

  // Stream D Phase 4 â€” plaintext name columns dropped; only ciphertext.
  const rows = await db
    .select({
      id: schema.transactions.id,
      date: schema.transactions.date,
      accountId: schema.transactions.accountId,
      accountNameCt: schema.accounts.nameCt,
      accountCurrency: schema.accounts.currency,
      categoryId: schema.transactions.categoryId,
      categoryNameCt: schema.categories.nameCt,
      categoryType: schema.categories.type,
      currency: schema.transactions.currency,
      amount: schema.transactions.amount,
      enteredAmount: schema.transactions.enteredAmount,
      enteredCurrency: schema.transactions.enteredCurrency,
      enteredFxRate: schema.transactions.enteredFxRate,
      quantity: schema.transactions.quantity,
      portfolioHoldingId: schema.transactions.portfolioHoldingId,
      portfolioHoldingNameCt: schema.portfolioHoldings.nameCt,
      note: schema.transactions.note,
      payee: schema.transactions.payee,
      tags: schema.transactions.tags,
      linkId: schema.transactions.linkId,
    })
    .from(schema.transactions)
    .leftJoin(schema.accounts, eq(schema.transactions.accountId, schema.accounts.id))
    .leftJoin(schema.categories, eq(schema.transactions.categoryId, schema.categories.id))
    .leftJoin(
      schema.portfolioHoldings,
      eq(schema.transactions.portfolioHoldingId, schema.portfolioHoldings.id),
    )
    .where(and(...conditions))
    .all();

  // Decrypt tx-level encrypted fields (payee/note/tags).
  const decrypted = decryptTxRows(
    dek,
    rows as Array<Parameters<typeof decryptTxRows>[1][number]>,
  ) as Array<typeof rows[number]>;

  // Stream D Phase 4 â€” plaintext name columns dropped. Decrypt name_ct and
  // surface as `accountName` / `categoryName` / `portfolioHolding`.
  const enriched = decrypted.map((r) => {
    let resolvedName: string | null = null;
    if (r.portfolioHoldingNameCt && dek) {
      try {
        resolvedName = decryptField(dek, r.portfolioHoldingNameCt);
      } catch {
        resolvedName = null;
      }
    }
    return {
      ...r,
      accountName: decryptName(r.accountNameCt, dek, null),
      categoryName: decryptName(r.categoryNameCt, dek, null),
      portfolioHolding: resolvedName,
      accountNameCt: undefined,
      categoryNameCt: undefined,
      portfolioHoldingNameCt: undefined,
    };
  });

  return NextResponse.json({ data: enriched });
}
