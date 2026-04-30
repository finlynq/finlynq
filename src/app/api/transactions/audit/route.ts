/**
 * GET /api/transactions/audit — list unresolved cross-currency rows for the user.
 *
 * Each row is a transaction whose recorded currency differs from its account's
 * currency. Phase 2 of the currency rework flagged these via the migration
 * script — see scripts/migrate-tx-three-currencies.sql. The user can resolve
 * each via PATCH below: 'converted' applies a historical rate, 'kept' accepts
 * the row as-is, 'edited' marks it as user-edited (the regular tx PUT applies
 * the actual change).
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/require-auth";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { db, schema } from "@/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { getRate } from "@/lib/fx-service";
import { invalidateUser as invalidateUserTxCache } from "@/lib/mcp/user-tx-cache";
import { logApiError, safeErrorMessage, validateBody } from "@/lib/validate";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;

  const includeResolved = request.nextUrl.searchParams.get("includeResolved") === "1";

  const conditions = [eq(schema.txCurrencyAudit.userId, userId)];
  if (!includeResolved) conditions.push(isNull(schema.txCurrencyAudit.resolvedAt));

  const rows = await db
    .select({
      id: schema.txCurrencyAudit.id,
      transactionId: schema.txCurrencyAudit.transactionId,
      accountCurrency: schema.txCurrencyAudit.accountCurrency,
      recordedCurrency: schema.txCurrencyAudit.recordedCurrency,
      recordedAmount: schema.txCurrencyAudit.recordedAmount,
      flaggedAt: schema.txCurrencyAudit.flaggedAt,
      resolvedAt: schema.txCurrencyAudit.resolvedAt,
      resolution: schema.txCurrencyAudit.resolution,
      txDate: schema.transactions.date,
      accountId: schema.transactions.accountId,
    })
    .from(schema.txCurrencyAudit)
    .leftJoin(schema.transactions, eq(schema.txCurrencyAudit.transactionId, schema.transactions.id))
    .where(and(...conditions))
    .orderBy(sql`${schema.txCurrencyAudit.flaggedAt} DESC`);

  const unresolvedCount = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.txCurrencyAudit)
    .where(
      and(
        eq(schema.txCurrencyAudit.userId, userId),
        isNull(schema.txCurrencyAudit.resolvedAt)
      )
    );

  return NextResponse.json({
    items: rows,
    unresolvedCount: unresolvedCount[0]?.count ?? 0,
  });
}

const patchSchema = z.object({
  id: z.number().int(),
  action: z.enum(["convert", "keep"]),
});

export async function PATCH(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const { userId } = auth;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = validateBody(body, patchSchema);
  if (parsed.error) return parsed.error;
  const { id, action } = parsed.data;

  try {
    const auditRow = await db
      .select({
        id: schema.txCurrencyAudit.id,
        transactionId: schema.txCurrencyAudit.transactionId,
        accountCurrency: schema.txCurrencyAudit.accountCurrency,
        recordedCurrency: schema.txCurrencyAudit.recordedCurrency,
        recordedAmount: schema.txCurrencyAudit.recordedAmount,
        resolvedAt: schema.txCurrencyAudit.resolvedAt,
        txDate: schema.transactions.date,
      })
      .from(schema.txCurrencyAudit)
      .leftJoin(schema.transactions, eq(schema.txCurrencyAudit.transactionId, schema.transactions.id))
      .where(
        and(
          eq(schema.txCurrencyAudit.id, id),
          eq(schema.txCurrencyAudit.userId, userId)
        )
      )
      .limit(1);

    if (!auditRow[0]) {
      return NextResponse.json({ error: "Audit row not found" }, { status: 404 });
    }
    if (auditRow[0].resolvedAt) {
      return NextResponse.json({ error: "Already resolved" }, { status: 400 });
    }

    if (action === "keep") {
      // Mark the audit resolved without touching the transaction. The entered_*
      // fields were already populated by the migration with the recorded
      // values + rate=1 — the row keeps its current (broken) state.
      await db
        .update(schema.txCurrencyAudit)
        .set({ resolvedAt: new Date(), resolution: "kept" })
        .where(eq(schema.txCurrencyAudit.id, id));
      return NextResponse.json({ ok: true, action: "kept" });
    }

    // Convert: fetch historical rate at the tx's date, rewrite currency/amount
    // to the account's currency, populate enteredFxRate.
    const date = auditRow[0].txDate ?? new Date().toISOString().split("T")[0];
    const rate = await getRate(
      auditRow[0].recordedCurrency,
      auditRow[0].accountCurrency,
      date,
      userId
    );
    const newAmount = Math.round(auditRow[0].recordedAmount * rate * 100) / 100;

    await db
      .update(schema.transactions)
      .set({
        currency: auditRow[0].accountCurrency,
        amount: newAmount,
        enteredCurrency: auditRow[0].recordedCurrency,
        enteredAmount: auditRow[0].recordedAmount,
        enteredFxRate: rate,
        // Issue #28: row mutation → bump audit timestamp.
        updatedAt: sql`NOW()`,
      })
      .where(
        and(
          eq(schema.transactions.id, auditRow[0].transactionId),
          eq(schema.transactions.userId, userId)
        )
      );

    await db
      .update(schema.txCurrencyAudit)
      .set({ resolvedAt: new Date(), resolution: "converted" })
      .where(eq(schema.txCurrencyAudit.id, id));

    invalidateUserTxCache(userId);
    return NextResponse.json({
      ok: true,
      action: "converted",
      newAmount,
      newCurrency: auditRow[0].accountCurrency,
      enteredFxRate: rate,
    });
  } catch (error: unknown) {
    await logApiError("PATCH", "/api/transactions/audit", error, userId);
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to resolve audit row") },
      { status: 500 }
    );
  }
}
