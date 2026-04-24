/**
 * GET    /api/import/staged/[id]  — detail + preview rows for approval
 * DELETE /api/import/staged/[id]  — reject (deletes staged rows via cascade)
 *
 * Approve lives at /api/import/staged/[id]/approve (separate file — it needs
 * DEK auth whereas detail + reject only need session auth).
 *
 * All routes are user-scoped via userId filter. 404 if the staged_import
 * doesn't belong to the caller.
 */

import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { and, eq, asc } from "drizzle-orm";
import { requireAuth } from "@/lib/auth/require-auth";
import { decryptStaged } from "@/lib/crypto/staging-envelope";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;
  const { id } = await params;

  const staged = await db
    .select()
    .from(schema.stagedImports)
    .where(and(
      eq(schema.stagedImports.id, id),
      eq(schema.stagedImports.userId, userId),
    ))
    .get();

  if (!staged) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const rows = await db
    .select({
      id: schema.stagedTransactions.id,
      date: schema.stagedTransactions.date,
      amount: schema.stagedTransactions.amount,
      currency: schema.stagedTransactions.currency,
      payee: schema.stagedTransactions.payee,
      category: schema.stagedTransactions.category,
      accountName: schema.stagedTransactions.accountName,
      note: schema.stagedTransactions.note,
      rowIndex: schema.stagedTransactions.rowIndex,
      isDuplicate: schema.stagedTransactions.isDuplicate,
    })
    .from(schema.stagedTransactions)
    .where(eq(schema.stagedTransactions.stagedImportId, id))
    .orderBy(asc(schema.stagedTransactions.rowIndex))
    .all();

  // Finding #9 — decrypt staging-envelope fields for the user preview.
  // Rows are stored sv1:...-encrypted in the DB; render as plaintext for the UI.
  const decryptedRows = rows.map((r) => ({
    ...r,
    payee: decryptStaged(r.payee),
    category: decryptStaged(r.category),
    accountName: decryptStaged(r.accountName),
    note: decryptStaged(r.note),
  }));

  return NextResponse.json({ staged, rows: decryptedRows });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;
  const { id } = await params;

  // Delete is scoped — if the id doesn't belong to this user, row count = 0
  // and we surface 404 without leaking that the id exists for someone else.
  const result = await db
    .delete(schema.stagedImports)
    .where(and(
      eq(schema.stagedImports.id, id),
      eq(schema.stagedImports.userId, userId),
    ));

  // Drizzle returns different shapes per dialect; check rowCount via any-cast.
  const rc = (result as unknown as { rowCount?: number }).rowCount ?? null;
  if (rc === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
