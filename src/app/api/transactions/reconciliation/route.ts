/**
 * GET /api/transactions/reconciliation?accountId=<int>&from=<YYYY-MM-DD>&to=<YYYY-MM-DD>
 *
 * Powers the left pane of the two-pane reconciliation UI on
 * `/import/pending` (FINLYNQ-56). Returns the user's existing
 * `transactions` rows for one account in a ±7-day window around the
 * staged batch's date range so the user can compare what's in the file
 * (right pane) with what's already in their account (left pane).
 *
 * `requireEncryption()` — decoded payee / category / note. Soft-fallback
 * was rejected (user decision 2026-05-20): the user is mid-import so they
 * already have a DEK; degrading to "—" rows would defeat the reconcile
 * surface.
 *
 * Cross-tenant attacks return 404 (consistent with the rest of the
 * staging surface — never 403, which would leak existence).
 *
 * Per-row enrichment:
 *   - `linkedStagedRowId` — the `staged_transactions.id` whose
 *     `linked_transaction_id` references this row. NULL when no staged
 *     row has been manually linked. PATCH on the staged row enforces
 *     0..1-ness; this query defensively picks the first if a race ever
 *     created multiples.
 *   - `reconciliationFlag` — the most-recent
 *     `transaction_reconciliation_flags` row, if any.
 *
 * Load-bearing rules honored:
 *   - User-scoped — `WHERE transactions.user_id = $userId` AND
 *     `WHERE accounts.user_id = $userId`. Cross-tenant accountId = 404.
 *   - No aggregator changes (CLAUDE.md issue #236). Raw row read only.
 */

import { NextRequest, NextResponse } from "next/server";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { decryptTxRows, decryptName } from "@/lib/crypto/encrypted-columns";

export const dynamic = "force-dynamic";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const { userId, dek } = auth;

  const params = request.nextUrl.searchParams;
  const accountIdRaw = params.get("accountId");
  const from = params.get("from");
  const to = params.get("to");

  if (!accountIdRaw || !from || !to) {
    return NextResponse.json(
      { error: "Missing required query params: accountId, from, to" },
      { status: 400 },
    );
  }
  const accountId = parseInt(accountIdRaw, 10);
  if (!Number.isFinite(accountId) || accountId <= 0) {
    return NextResponse.json({ error: "Invalid accountId" }, { status: 400 });
  }
  if (!ISO_DATE_RE.test(from) || !ISO_DATE_RE.test(to)) {
    return NextResponse.json(
      { error: "from and to must be YYYY-MM-DD" },
      { status: 400 },
    );
  }
  if (from > to) {
    return NextResponse.json(
      { error: "from must be <= to" },
      { status: 400 },
    );
  }

  // Verify the account belongs to this user. Cross-tenant attack returns
  // 404 without leaking that the account id exists for someone else.
  const acct = await db
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(and(
      eq(schema.accounts.id, accountId),
      eq(schema.accounts.userId, userId),
    ))
    .get();
  if (!acct) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Primary query — transactions for the (user, account, date range)
  // grain, joined to category (for the encrypted name + type) and to
  // staged_transactions (for the back-reference). The back-ref is 0..1
  // by PATCH-side enforcement; LEFT JOIN here surfaces the linked id
  // when present, NULL otherwise.
  const rows = await db
    .select({
      id: schema.transactions.id,
      date: schema.transactions.date,
      amount: schema.transactions.amount,
      currency: schema.transactions.currency,
      payee: schema.transactions.payee,
      note: schema.transactions.note,
      tags: schema.transactions.tags,
      accountId: schema.transactions.accountId,
      categoryId: schema.transactions.categoryId,
      categoryNameCt: schema.categories.nameCt,
      categoryType: schema.categories.type,
      linkedStagedRowId: schema.stagedTransactions.id,
    })
    .from(schema.transactions)
    .leftJoin(
      schema.categories,
      eq(schema.transactions.categoryId, schema.categories.id),
    )
    .leftJoin(
      schema.stagedTransactions,
      eq(schema.stagedTransactions.linkedTransactionId, schema.transactions.id),
    )
    .where(and(
      eq(schema.transactions.userId, userId),
      eq(schema.transactions.accountId, accountId),
      gte(schema.transactions.date, from),
      lte(schema.transactions.date, to),
    ))
    .orderBy(asc(schema.transactions.date), asc(schema.transactions.id))
    .all();

  // Dedupe by transaction id — defensive against a race that ever placed
  // two staged_transactions.linked_transaction_id rows on the same tx.
  // Picks the first (lowest staged row id by Postgres sort stability).
  const byId = new Map<number, typeof rows[number]>();
  for (const r of rows) {
    if (!byId.has(r.id)) byId.set(r.id, r);
  }
  const deduped = Array.from(byId.values());

  // Secondary query — fetch flags for these tx ids in one shot, then map
  // back. Simpler than a third JOIN with row-multiplier concerns; one
  // round-trip difference at sub-100ms per pane render.
  const txIds = deduped.map((r) => r.id);
  let flagsByTxId = new Map<
    number,
    { kind: string; note: string | null }
  >();
  if (txIds.length > 0) {
    const flagRows = await db
      .select({
        transactionId: schema.transactionReconciliationFlags.transactionId,
        flagKind: schema.transactionReconciliationFlags.flagKind,
        note: schema.transactionReconciliationFlags.note,
        createdAt: schema.transactionReconciliationFlags.createdAt,
      })
      .from(schema.transactionReconciliationFlags)
      .where(and(
        eq(schema.transactionReconciliationFlags.userId, userId),
      ))
      .all();
    // Keep only flags for txIds in our window, latest-first per tx.
    const txIdSet = new Set(txIds);
    const sorted = flagRows
      .filter((f) => txIdSet.has(f.transactionId))
      .sort((a, b) =>
        (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0),
      );
    for (const f of sorted) {
      if (!flagsByTxId.has(f.transactionId)) {
        flagsByTxId.set(f.transactionId, { kind: f.flagKind, note: f.note });
      }
    }
  }

  // Decrypt tx-level encrypted fields (payee/note/tags). decryptTxRows
  // is a no-op when dek is null (we have a DEK by requireEncryption).
  const decrypted = decryptTxRows(
    dek,
    deduped as Array<Parameters<typeof decryptTxRows>[1][number]>,
  ) as Array<typeof deduped[number]>;

  const transactions = decrypted.map((r) => {
    const categoryName = decryptName(r.categoryNameCt, dek, null);
    return {
      id: r.id,
      date: r.date,
      amount: r.amount,
      currency: r.currency,
      payee: (r.payee ?? null) as string | null,
      category: categoryName,
      note: (r.note ?? null) as string | null,
      // txType is derived from the linked category's type. NULL when
      // uncategorized — the UI renders that as a neutral row.
      txType: (r.categoryType as "E" | "I" | "R" | "T" | null) ?? null,
      linkedStagedRowId: r.linkedStagedRowId ?? null,
      reconciliationFlag: flagsByTxId.get(r.id) ?? null,
    };
  });

  return NextResponse.json({
    success: true,
    data: { transactions },
  });
}
