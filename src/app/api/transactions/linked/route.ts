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
      // Stream D Phase 3 cutover NULLs `accounts.name` — pull the ciphertext
      // alongside so we can decrypt with the session DEK below.
      accountNameCt: schema.accounts.nameCt,
      accountCurrency: schema.accounts.currency,
      categoryId: schema.transactions.categoryId,
      categoryName: schema.categories.name,
      categoryNameCt: schema.categories.nameCt,
      // categoryType lets the client run the "transfer pair" four-check rule
      // (link_id non-null + 1 sibling + both type='R' + different accounts)
      // and decide whether to render the unified Transfer edit view or the
      // legacy linked-siblings panel for non-symmetric multi-leg imports.
      categoryType: schema.categories.type,
      currency: schema.transactions.currency,
      amount: schema.transactions.amount,
      // Surface entered-side fields so the unified edit view can pre-fill
      // the "Amount received" override box for cross-currency pairs without
      // a second round-trip.
      enteredAmount: schema.transactions.enteredAmount,
      enteredCurrency: schema.transactions.enteredCurrency,
      enteredFxRate: schema.transactions.enteredFxRate,
      quantity: schema.transactions.quantity,
      // Holding name comes from a JOIN to portfolio_holdings via the FK.
      // Phase 5 (2026-04-29) NULL'd the legacy text column on every row.
      portfolioHoldingId: schema.transactions.portfolioHoldingId,
      portfolioHoldingNameJoined: schema.portfolioHoldings.name,
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

  // Resolve the holding name with a fallback ladder:
  //   1. JOINed plaintext (Stream D legacy or pre-Phase-3 row)
  //   2. JOINed nameCt decrypted with the session DEK (Phase 3 NULL'd row)
  // The first non-empty wins. We surface this as a single `portfolioHolding`
  // string so the client can ignore the underlying source. Same ladder runs
  // for accountName + categoryName via decryptName().
  const enriched = decrypted.map((r) => {
    let resolvedName = r.portfolioHoldingNameJoined ?? null;
    if (!resolvedName && r.portfolioHoldingNameCt && dek) {
      try {
        resolvedName = decryptField(dek, r.portfolioHoldingNameCt);
      } catch {
        resolvedName = null;
      }
    }
    return {
      ...r,
      accountName: decryptName(r.accountNameCt, dek, r.accountName),
      categoryName: decryptName(r.categoryNameCt, dek, r.categoryName),
      portfolioHolding: resolvedName,
      // Strip the JOIN fields from the response shape — the client uses
      // the resolved `portfolioHolding` / `accountName` / `categoryName`.
      accountNameCt: undefined,
      categoryNameCt: undefined,
      portfolioHoldingNameJoined: undefined,
      portfolioHoldingNameCt: undefined,
    };
  });

  return NextResponse.json({ data: enriched });
}
